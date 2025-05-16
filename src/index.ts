import { Hono } from "hono";

import type { StatusCode } from "hono/utils/http-status";
import type { ScreenshotBrowserDO } from "./browser-durable-object"; // Ensure ScreenshotBrowserDO is imported if type is used for stub

const app = new Hono<{ Bindings: Env }>();

app.get("/screenshot", async (c) => {
  const targetUrl = c.req.query("url");
  const directOutput = c.req.query("directOutput") === "true";

  if (!targetUrl) {
    return c.text("Missing 'url' query parameter", 400);
  }

  try {
    const doId = c.env.SCREENSHOT_BROWSER_DO.idFromName("default-browser-instance");
    // It's good practice to type the stub if you know the DO's interface,
    // though not strictly necessary for RPC to work if methods are public.
    const stub = c.env.SCREENSHOT_BROWSER_DO.get(doId) as unknown as ScreenshotBrowserDO;

    // Call the RPC method
    const result = await stub.takeScreenshotJob(targetUrl, directOutput);

    if (directOutput && result instanceof ArrayBuffer) {
      return new Response(result, { headers: { "Content-Type": "image/png" }, status: 200 });
    }
    if (!directOutput && typeof result === "string") {
      return c.json({ success: true, r2Key: result }, 200);
    }

    // This case implies an unexpected result type from the DO not covered above or an error that wasn't thrown.
    console.error("Mismatched result type from DO RPC call or unexpected result.", { result });
    return c.text("Internal error: Mismatched or unexpected result type from Durable Object.", 500);
  } catch (error) {
    console.error("Error in /screenshot endpoint (RPC call to DO):", error);

    let message = "Failed to process screenshot request via RPC";
    let status: StatusCode = 500;
    const headers: Record<string, string> = {};

    if (error instanceof Error) {
      message = error.message;
      if (error.name === "NoAvailableSessionError") {
        status = 503; // Service Unavailable
        headers["Retry-After"] = "30";
      } else if (error.message?.includes("timed out in queue")) {
        status = 504; // Gateway Timeout
      } else if (error.message?.includes("timed out")) {
        // More generic timeout from DO operations
        status = 504; // Gateway Timeout
      }
      // Add more specific error checks if the DO can throw other distinct error types/names
    }

    return c.text(message, status, headers);
  }
});

export default app;
export * from "./browser-durable-object";
