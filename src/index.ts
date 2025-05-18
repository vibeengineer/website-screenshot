import { serve } from "@hono/node-server";
import { config } from "dotenv";
import { Hono } from "hono";

config();

import { queueManager } from "./queue";
import { takeScreenshotWithBrowserless } from "./screenshot";

queueManager.setScreenshotExecutor(async (targetUrl, sessionId) => {
  const result = await takeScreenshotWithBrowserless(targetUrl, sessionId);
  return result.buffer;
});

const app = new Hono();

app.get("/", (c) => {
  return c.notFound();
});

app.get("/screenshot", async (c) => {
  const targetUrl = c.req.query("url");

  if (!targetUrl) {
    return c.json({ error: "Invalid request payload", success: false, data: null }, 400);
  }

  try {
    console.log(`[index.ts] Received screenshot request for URL: ${targetUrl}`);

    const result = await queueManager.queueScreenshotJob(targetUrl);

    console.log(
      `[index.ts] Screenshot successful for ${targetUrl}, session ID: ${result.sessionId}`
    );

    c.header("Content-Type", "image/png");
    c.header("X-Browserless-Session-Id", result.sessionId);
    return c.body(result.buffer);
  } catch (error) {
    console.error(`[index.ts] Error in /screenshot route for ${targetUrl}:`, error);
    let message = "Failed to take screenshot.";
    if (error instanceof Error) {
      message = error.message;
    }
    return c.text(message, 500);
  }
});

const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3000;
console.log(`Server is running on port ${port}`);

const server = serve({
  fetch: app.fetch,
  port: port,
});

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down gracefully...");
  server.close(() => {
    console.log("Server closed.");
    process.exit(0);
  });
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully...");
  server.close(() => {
    console.log("Server closed.");
    process.exit(0);
  });
});

export default app;
