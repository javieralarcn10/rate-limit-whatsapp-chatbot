import { Redis } from "ioredis";

// One shared connection: the rate limiter and the Chat SDK state
// (locks, debounce queue, dedupe, history) both live in the same Redis.
export const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
	maxRetriesPerRequest: 3,
	enableAutoPipelining: true,
});
