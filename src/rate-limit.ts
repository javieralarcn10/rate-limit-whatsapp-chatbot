import { redis } from "./redis.js";

// Layer 1: how many AI replies a single conversation can trigger.
const BURST_WINDOW_SEC = 2 * 60; // 2 minutes
const BURST_LIMIT = 30; // max. 30 AI replies every 2 minutes

const DAILY_WINDOW_SEC = 24 * 60 * 60; // 24 hours
const DAILY_LIMIT = 150; // max. 150 AI replies per day

// Layer 2 is the Chat SDK debounce, configured in bot.ts.

// Layer 3: the first time a limit is exceeded the user gets a warning. If
// they send another message while still over the limit, they get blocked.
// The real block happens in WhatsApp (see zernio.ts); this Redis key only
// keeps the bot silent while that block takes effect, or if it fails.
const BLOCK_TTL_SEC = 24 * 60 * 60; // 24 hours

export const WARNING_MESSAGE =
	"You have reached the message limit. If you send another message, this number will be blocked.";

export type RateLimitResult =
	/** Under the limits: the AI can answer. */
	| { action: "allow" }
	/** Already blocked: drop the message without answering. */
	| { action: "ignore" }
	/** First time over the limit: send WARNING_MESSAGE. */
	| { action: "warn" }
	/** Over the limit again after the warning: block the user. */
	| { action: "block" };

function keysFor(userKey: string) {
	return {
		burst: `ratelimit:burst:${userKey}`,
		daily: `ratelimit:daily:${userKey}`,
		warned: `ratelimit:warned:${userKey}`,
		blocked: `ratelimit:blocked:${userKey}`,
	};
}

/**
 * Fixed-window counter. INCR and EXPIRE NX go in the same transaction, so a
 * crash between them can never leave a counter without a TTL (which would
 * block the user forever).
 */
async function incrWithExpire(key: string, ttlSec: number): Promise<number> {
	const results = await redis.multi().incr(key).expire(key, ttlSec, "NX").exec();
	const [error, count] = results?.[0] ?? [];
	if (error) throw error;
	return count as number;
}

/**
 * Decides whether a conversation can still spend AI tokens.
 *
 * Call it BEFORE anything that costs money: transcribing audio, analyzing
 * images or PDFs, or calling the model.
 *
 * Fail-open: if Redis is down the message goes through. One extra reply is
 * cheaper than a support bot that stops answering real customers.
 */
export async function checkRateLimit(userKey: string): Promise<RateLimitResult> {
	try {
		const keys = keysFor(userKey);

		if (await redis.exists(keys.blocked)) return { action: "ignore" };

		// Layer 1: short burst window and daily window.
		const [burstCount, dailyCount] = await Promise.all([
			incrWithExpire(keys.burst, BURST_WINDOW_SEC),
			incrWithExpire(keys.daily, DAILY_WINDOW_SEC),
		]);

		if (burstCount <= BURST_LIMIT && dailyCount <= DAILY_LIMIT) {
			return { action: "allow" };
		}

		// Layer 3: the warning lasts as long as the window that was exceeded,
		// so a user who waits it out starts clean.
		const warningTtlSec = dailyCount > DAILY_LIMIT ? DAILY_WINDOW_SEC : BURST_WINDOW_SEC;
		const firstWarning = await redis.set(keys.warned, "1", "EX", warningTtlSec, "NX");
		if (firstWarning) return { action: "warn" };

		await redis.multi().set(keys.blocked, "1", "EX", BLOCK_TTL_SEC).del(keys.warned).exec();
		return { action: "block" };
	} catch (error) {
		console.error("[RateLimit] Redis error, letting the message through:", error);
		return { action: "allow" };
	}
}
