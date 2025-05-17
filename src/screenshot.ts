import { PlaywrightBlocker } from "@ghostery/adblocker-playwright";
import fetch from "cross-fetch";
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";
import {
  BASE_IMAGE_URL,
  BROWSER_CONNECT_TIMEOUT,
  OVERLAY_IMAGE_URL,
  PAGE_GOTO_TIMEOUT,
  SCREENSHOT_TIMEOUT,
  VIEWPORT_HEIGHT,
  VIEWPORT_WIDTH,
} from "./constants";
import { BrowserConnectionError, ScreenshotTimeoutError } from "./errors";
import { queueManager } from "./queue";
import { putScreenshotInsideTemplate } from "./template";

interface ScreenshotOptions {
  adBlock?: boolean;
}

// Track active browser
let activeBrowser: Browser | null = null;

// Check if keep-alive is enabled via environment variable
const ENABLE_KEEP_ALIVE = process.env.ENABLE_KEEP_ALIVE === "true";

async function getBrowserlessUrl(): Promise<string> {
  const browserlessUrl = process.env.BROWSERLESS_URL || "http://browserless:3000";
  return browserlessUrl;
}

async function getConnectUrl(): Promise<string> {
  const browserlessUrl = await getBrowserlessUrl();
  const token = process.env.BROWSERLESS_TOKEN;

  // Based on browserless documentation and configuration
  // Just use the base websocket URL without the /playwright path
  let wsEndpoint = `${browserlessUrl.replace("http", "ws")}`;

  // Add token if provided (required for authentication)
  if (token) {
    wsEndpoint += `?token=${token}`;
  }

  // Add anti-captcha and bot detection bypass args
  const launchArgs = JSON.stringify({
    headless: false,
    stealth: true,
  });

  // Append launch args to the URL
  wsEndpoint += wsEndpoint.includes("?") ? `&launch=${launchArgs}` : `?launch=${launchArgs}`;

  return wsEndpoint;
}

async function connectToBrowser(retryAttempts = 2): Promise<Browser> {
  let lastError: Error | undefined;
  const connectUrl = await getConnectUrl();

  for (let attempt = 0; attempt <= retryAttempts; attempt++) {
    try {
      if (attempt > 0) {
        console.log(
          `[screenshotService] Retrying browser connection (attempt ${attempt}/${retryAttempts})`
        );
        // Small delay before retry
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      // Use connectOverCDP for browserless which uses Chrome DevTools Protocol
      const browserPromise = chromium.connectOverCDP(connectUrl);
      const timeoutPromise = new Promise<Browser>((_, reject) => {
        setTimeout(
          () => reject(new BrowserConnectionError("Browser connection timed out")),
          BROWSER_CONNECT_TIMEOUT
        );
      });

      return await Promise.race([browserPromise, timeoutPromise]);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(
        `[screenshotService] Browser connection attempt ${attempt + 1}/${
          retryAttempts + 1
        } failed:`,
        lastError.message
      );
    }
  }

  throw lastError || new BrowserConnectionError("Failed to connect to browser after retries");
}

async function setupPage(
  page: Page,
  requestSessionId: string,
  options: ScreenshotOptions
): Promise<void> {
  if (options.adBlock !== false) {
    console.log(`[screenshotService] [${requestSessionId}] Initializing adblocker...`);
    const blocker = await PlaywrightBlocker.fromPrebuiltAdsAndTracking(fetch);
    await blocker.enableBlockingInPage(page);
    console.log(`[screenshotService] [${requestSessionId}] Adblocker enabled.`);
  }

  // Add scrollbar hiding styles
  await page.addStyleTag({
    content: `
      ::-webkit-scrollbar { 
        width: 0px !important;
        height: 0px !important;
        display: none !important;
      }
      * { 
        -ms-overflow-style: none !important;
        scrollbar-width: none !important;
        overflow: -moz-scrollbars-none !important;
      }
      html, body {
        overflow: hidden !important;
        scrollbar-width: none !important;
      }
    `,
  });
  console.log(`[screenshotService] [${requestSessionId}] Scrollbar hiding styles added.`);
}

async function getRawScreenshot(
  targetUrl: string,
  requestSessionId: string,
  options: ScreenshotOptions = {}
): Promise<Buffer> {
  let browser: Browser | null = null;
  let usingExistingBrowser = false;

  try {
    // Try to reuse existing browser if keep-alive is enabled
    if (ENABLE_KEEP_ALIVE && activeBrowser && activeBrowser.isConnected()) {
      try {
        console.log(
          `[screenshotService] [${requestSessionId}] Reusing existing browser connection for URL: ${targetUrl}`
        );
        browser = activeBrowser;
        usingExistingBrowser = true;
      } catch (reconnectError) {
        console.error(
          `[screenshotService] [${requestSessionId}] Failed to reuse existing browser:`,
          reconnectError
        );
        activeBrowser = null; // Reset the active browser since we couldn't use it
      }
    }

    // Create a new browser connection if needed
    if (!browser) {
      console.log(
        `[screenshotService] [${requestSessionId}] Creating new browser connection for URL: ${targetUrl}`
      );
      browser = await connectToBrowser();
      activeBrowser = browser; // Store for potential reuse
    }

    // Create a new context and page with anti-bot-detection settings
    const context = await browser.newContext({
      viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      hasTouch: true,
      isMobile: false,
      deviceScaleFactor: 1,
      javaScriptEnabled: true,
      bypassCSP: true,
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();

    await setupPage(page, requestSessionId, options);

    // Add initial scrollbar hiding
    await page.addStyleTag({
      content: `
        ::-webkit-scrollbar { display: none !important; }
        * { 
          -ms-overflow-style: none !important;
          scrollbar-width: none !important;
          overflow: -moz-scrollbars-none !important;
        }
        html, body {
          overflow: hidden !important;
          scrollbar-width: none !important;
        }
      `,
    });

    await page.goto(targetUrl, {
      waitUntil: "networkidle",
      timeout: PAGE_GOTO_TIMEOUT,
    });

    await page.evaluate(() => {
      document.documentElement.style.overflow = "hidden";
      document.body.style.overflow = "hidden";
      const style = document.createElement("style");
      style.textContent = `
        ::-webkit-scrollbar { 
          width: 0px !important;
          height: 0px !important;
          display: none !important;
        }
        * { 
          -ms-overflow-style: none !important;
          scrollbar-width: none !important;
          overflow: -moz-scrollbars-none !important;
        }
        html, body {
          overflow: hidden !important;
          scrollbar-width: none !important;
        }
      `;
      document.head.appendChild(style);
    });

    const screenshotPromise = page.screenshot();
    const timeoutPromise = new Promise<Buffer>((_, reject) => {
      setTimeout(() => reject(new ScreenshotTimeoutError("Screenshot capture timed out")), 5000);
    });

    const screenshotBuffer = await Promise.race([screenshotPromise, timeoutPromise]);

    // Close the context to clean up
    await context.close();

    return screenshotBuffer;
  } catch (error) {
    console.error(
      `[screenshotService] [${requestSessionId}] Error getting raw screenshot for ${targetUrl}:`,
      error
    );

    // If this was a reused browser that failed, clear it
    if (usingExistingBrowser && activeBrowser) {
      console.log(`[screenshotService] [${requestSessionId}] Clearing failed reused browser`);
      try {
        await activeBrowser.close();
      } catch (closeError) {
        console.error(
          `[screenshotService] [${requestSessionId}] Error closing browser:`,
          closeError
        );
      }
      activeBrowser = null;
    }

    throw error;
  } finally {
    // If we're not keeping the browser alive or there are no queued items, close it
    if (!ENABLE_KEEP_ALIVE || !queueManager.hasQueuedItems()) {
      if (browser && !usingExistingBrowser) {
        try {
          await browser.close();
          activeBrowser = null;
        } catch (closeError) {
          console.error(
            `[screenshotService] [${requestSessionId}] Error closing browser:`,
            closeError
          );
        }
      }
    }
  }
}

export async function takeScreenshotWithBrowserless(
  targetUrl: string,
  requestSessionId: string = crypto.randomUUID(),
  options: ScreenshotOptions = {}
): Promise<{
  buffer: Buffer;
  sessionId: string;
}> {
  const startTime = Date.now();

  try {
    console.log(
      `[screenshotService] [${requestSessionId}] Starting screenshot process for ${targetUrl}`
    );

    checkTimeout(startTime);

    const rawBuffer = await getRawScreenshot(targetUrl, requestSessionId, options);

    console.log(
      `[screenshotService] [${requestSessionId}] Generating styled image for ${targetUrl}`
    );

    const processedBuffer = await putScreenshotInsideTemplate(
      rawBuffer,
      BASE_IMAGE_URL,
      OVERLAY_IMAGE_URL
    );

    console.log(
      `[screenshotService] [${requestSessionId}] Styled image generated for ${targetUrl}, size: ${processedBuffer.length} bytes`
    );

    logCompletionTime(startTime, requestSessionId, targetUrl);

    return {
      buffer: processedBuffer,
      sessionId: requestSessionId,
    };
  } catch (error) {
    logError(error, startTime, requestSessionId, targetUrl);
    throw error;
  }
}

function checkTimeout(startTime: number): void {
  if (Date.now() - startTime > SCREENSHOT_TIMEOUT) {
    throw new ScreenshotTimeoutError("Screenshot process timed out");
  }
}

function logCompletionTime(startTime: number, requestSessionId: string, targetUrl: string): void {
  const totalTime = Date.now() - startTime;
  console.log(
    `[screenshotService] [${requestSessionId}] Screenshot process completed in ${totalTime}ms`
  );
}

function logError(
  error: unknown,
  startTime: number,
  requestSessionId: string,
  targetUrl: string
): void {
  const totalTime = Date.now() - startTime;
  console.error(
    `[screenshotService] [${requestSessionId}] Error taking screenshot for ${targetUrl} after ${totalTime}ms:`,
    error
  );
}
