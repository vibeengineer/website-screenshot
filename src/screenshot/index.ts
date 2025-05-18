import type { Logger } from "pino";
import { PAGE_GOTO_TIMEOUT, withTimeout } from "../utils/constants.js";
import type { BrowserManager } from "./browser-manager.js";

export type ScreenshotService = {
  capture: (url: string, opts?: { adBlock?: boolean; sessionId?: string }) => Promise<Buffer>;
};

export function createScreenshotService({
  browserManager,
  renderTemplate,
  logger,
  setupPage,
}: {
  browserManager: BrowserManager;
  renderTemplate: (buf: Buffer) => Promise<Buffer>;
  logger: Logger;
  setupPage: typeof import("./page-setup.js").setupPage;
}): ScreenshotService {
  const capture: ScreenshotService["capture"] = async (
    url,
    { adBlock = true, sessionId = crypto.randomUUID() } = {}
  ) => {
    const browser = await browserManager.getBrowser();
    const context = await browser.newContext();
    const page = await context.newPage();

    await setupPage(page, { adBlock }, logger);

    await withTimeout(
      page.goto(url, { waitUntil: "networkidle" }),
      PAGE_GOTO_TIMEOUT,
      "page.goto timed out"
    );

    if ((page as any).waitUntilClean) {
      await (page as any).waitUntilClean();
      console.log("…waitUntilClean done");
    }

    const raw = await page.screenshot();
    await context.close();

    const styled = await renderTemplate(raw);
    logger.info({ url, sessionId }, "screenshot complete");
    return styled;
  };

  return { capture };
}
