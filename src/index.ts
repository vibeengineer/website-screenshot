import { Hono } from "hono";

const app = new Hono<{ Bindings: Env }>();

app.get("/screenshot", async (c) => {
  const targetUrl = c.req.query("url");

  if (!targetUrl) {
    return c.text("Missing 'url' query parameter", 400);
  }

  try {
    // Use a consistent name for the Durable Object ID to interact with the same instance
    // or a specific group of instances if you implement sharding by ID name.
    const doId = c.env.SCREENSHOT_BROWSER_DO.idFromName("default-browser-instance");
    const stub = c.env.SCREENSHOT_BROWSER_DO.get(doId);

    // Forward the original request to the Durable Object.
    // The DO's fetch method is designed to handle the /screenshot?url=... path itself.
    const doResponse = await stub.fetch(c.req.raw);
    return doResponse;
  } catch (error) {
    console.error("Error in /screenshot endpoint:", error);
    return c.text(
      error instanceof Error ? error.message : "Failed to process screenshot request",
      500
    );
  }
});

export default app;
export * from "./browser-durable-object";
