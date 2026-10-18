import { generateText, type ModelMessage } from "ai";

// Any model from Vercel AI Gateway works here; it only needs AI_GATEWAY_API_KEY.
const MODEL = "openai/gpt-4.1-mini";

const INSTRUCTIONS = `You are the WhatsApp support agent of an online store.
Answer briefly and in the customer's language.
WhatsApp does not render Markdown headings or tables: use plain text.`;

export async function generateReply(messages: ModelMessage[]) {
	const { text } = await generateText({
		model: MODEL,
		instructions: INSTRUCTIONS,
		messages,
		// A hard cap per reply, so one call can never cost more than expected.
		maxOutputTokens: 800,
	});
	return text;
}
