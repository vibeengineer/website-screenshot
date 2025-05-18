import { serve } from "@hono/node-server";
import { env } from "./utils/env.js";
import { logger } from "./utils/logger.js";

import { createQueueManager } from "./queue/manager.js";
import { renderTemplate } from "./rendering/template-renderer.js";
import { createBrowserManager } from "./screenshot/browser-manager.js";
import { createScreenshotService } from "./screenshot/index.js";
import { setupPage } from "./screenshot/page-setup.js";
import { createHttpServer } from "./server/http-server.js";

const browserManager = createBrowserManager(env, logger);
const screenshotService = createScreenshotService({
  browserManager,
  renderTemplate,
  logger,
  setupPage,
});
const queue = createQueueManager({
  screenshotService,
  logger,
  timeout: env.QUEUE_TIMEOUT,
  concurrency: env.MAX_CONCURRENT_BROWSER_SESSIONS,
});

const app = createHttpServer(queue, logger);

const server = serve({
  fetch: app.fetch,
  port: env.PORT,
});

logger.info(`HTTP server listening on ${env.PORT}`);

process.on("SIGINT", async () => {
  logger.info("SIGINT received – shutting down");
  await browserManager.closeAll();
  server.close();
});
