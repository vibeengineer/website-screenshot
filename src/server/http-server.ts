import { Hono } from "hono";
import type { Logger } from "pino";
import type { QueueManager } from "../queue/manager.js";

export const createHttpServer = (queue: QueueManager, logger: Logger) => {
  const app = new Hono();

  app.get("/", (c) => c.text("👋"));

  app.get("/screenshot", async (c) => {
    const url = c.req.query("url");
    if (!url) return c.json({ success: false, error: "missing url" }, 400);

    try {
      const { buffer, sessionId } = await queue.enqueue(url);
      c.header("Content-Type", "image/png");
      c.header("X-Browserless-Session-Id", sessionId);
      return c.body(buffer ?? "");
    } catch (err) {
      logger.error(err, "screenshot failed");
      return c.json({ success: false, error: String(err) }, 500);
    }
  });

  return app;
};
