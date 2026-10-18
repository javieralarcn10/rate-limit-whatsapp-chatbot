import { createIoRedisState } from "@chat-adapter/state-ioredis";
import { createZernioAdapter } from "@zernio/chat-sdk-adapter";
import { type Adapter, Chat, type Message, type WebhookOptions } from "chat";
import { generateReply } from "./agent.js";
import { checkRateLimit, WARNING_MESSAGE } from "./rate-limit.js";
import { redis } from "./redis.js";
import { blockWhatsAppUser } from "./zernio.js";

// @zernio/chat-sdk-adapter (0.5.1) parses incoming messages with an empty
// threadId. The debounce strategy stores messages in Redis and routes them by
// message.threadId when it reads them back, so without this every debounced
// message fails with "Invalid Zernio thread ID format".
class ZernioChat extends Chat {
	override processMessage(
		adapter: Adapter,
		threadId: string,
		message: Message | (() => Promise<Message>),
		options?: WebhookOptions,
	) {
		const withThreadId = async () => {
			const parsed = typeof message === "function" ? await message() : message;
			(parsed as { threadId: string }).threadId = threadId;
			return parsed;
		};
		return super.processMessage(adapter, threadId, withThreadId, options);
	}
}

// Reads ZERNIO_API_KEY and ZERNIO_WEBHOOK_SECRET from the environment.
// The adapter verifies the HMAC signature of every webhook, and the Chat SDK
// drops duplicated deliveries, so retries never trigger a second AI call.
const zernio = createZernioAdapter();

export const bot = new ZernioChat({
	userName: "support-bot",
	adapters: { zernio },
	state: createIoRedisState({ client: redis }),
	// Layer 2: debounce. Every message that arrives within 10 seconds of the
	// previous one resets the timer, and the whole burst is answered with a
	// single AI call. 100 messages in a row cost one reply, not 100.
	concurrency: { strategy: "debounce", debounceMs: 10_000 },
	history: {
		user: {
			// Thread id = "zernio:{accountId}:{conversationId}": one history per
			// WhatsApp number and customer.
			identity: ({ message }) => message.threadId ?? null,
			retention: "30d",
			maxPerUser: 100,
		},
	},
	logger: "error",
});

bot.onDirectMessage(async (thread, message, _channel, context) => {
	// Rate limit first, before any paid work. The key is the thread, so a
	// limit on one customer never affects the others.
	const { action } = await checkRateLimit(thread.id);
	if (action === "ignore") return;
	if (action === "warn") {
		await thread.post(WARNING_MESSAGE);
		return;
	}
	if (action === "block") {
		const { accountId } = zernio.decodeThreadId(thread.id);
		await blockWhatsAppUser({ accountId, user: message.author.userId });
		return;
	}

	// Messages swallowed by the debounce, plus the last one.
	const userText = [...(context?.skipped ?? []), message]
		.map((item) => item.text.trim())
		.filter(Boolean)
		.join("\n\n");
	if (!userText) return;

	const userKey = thread.id;
	const recent = await bot.history.user.list({ userKey, limit: 20 });

	await thread.startTyping();
	const reply = await generateReply([
		...recent.map((item) => ({ role: item.role, content: item.text })),
		{ role: "user", content: userText },
	]);
	await thread.post(reply);

	// Saved only after the reply goes out, so a failed attempt does not leave
	// the user message in the history twice.
	await bot.history.user.append(thread, { role: "user", text: userText }, { userKey });
	await bot.history.user.append(thread, { role: "assistant", text: reply }, { userKey });
});
