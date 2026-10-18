import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bot } from "./bot.js";

const app = new Hono();

app.get("/", (c) => c.text("ok"));

// Point the Zernio webhook here, with the message.received event.
// The response goes back right away; the handler keeps running in the
// background of this long-lived Node process.
app.post("/webhooks/zernio", (c) => bot.webhooks.zernio(c.req.raw));

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => {
	console.log(`Listening on http://localhost:${port}`);
});
