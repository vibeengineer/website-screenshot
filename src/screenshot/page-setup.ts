import { PlaywrightBlocker } from "@ghostery/adblocker-playwright";
import fetch from "cross-fetch";
import type { Logger } from "pino";
import type { Page } from "playwright-core";
import { VIEWPORT_HEIGHT, VIEWPORT_WIDTH } from "../utils/constants.js";

type SetupOptions = { adBlock?: boolean };

export async function setupPage(page: Page, { adBlock = true }: SetupOptions, logger: Logger) {
  await page.setViewportSize({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });

  if (adBlock) {
    const blocker = await PlaywrightBlocker.fromPrebuiltAdsAndTracking(fetch);
    await blocker.enableBlockingInPage(page);
    logger.debug("adblock enabled");
  }

  await page.addStyleTag({
    content: "::-webkit-scrollbar{display:none}html,body{overflow:hidden}",
  });

  // ☆ future: cookie‑banner killer or stealth tweaks here
}
