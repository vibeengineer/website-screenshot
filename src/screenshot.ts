import Browserbase from "@browserbasehq/sdk";
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

type Geolocation = {
  city?: string;
  state?: string;
  country: string;
};

interface BrowserbaseProxyConfig {
  type: "browserbase";
  geolocation?: Geolocation;
  domainPattern?: string;
}

interface ExternalProxyConfig {
  type: "external";
  server: string;
  username?: string;
  password?: string;
  domainPattern?: string;
}

type ProxyConfig = BrowserbaseProxyConfig | ExternalProxyConfig;

interface ScreenshotOptions {
  useAdvancedStealth?: boolean;
  solveCaptchas?: boolean;
  proxies?: ProxyConfig[] | boolean;
}

interface BrowserSettings {
  fingerprint: {
    screen: {
      maxWidth: number;
      maxHeight: number;
      minWidth: number;
      minHeight: number;
    };
  };
  viewport: {
    width: number;
    height: number;
  };
  advancedStealth?: boolean;
  solveCaptchas?: boolean;
}

class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

interface RawScreenshotResult {
  buffer: Buffer;
  sessionId: string;
}

function validateBrowserbaseCredentials(): { apiKey: string; projectId: string } {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;

  if (!apiKey) {
    console.error("BROWSERBASE_API_KEY is not set.");
    throw new Error("Browserbase API Key is missing.");
  }
  if (!projectId) {
    console.error("BROWSERBASE_PROJECT_ID is not set.");
    throw new Error("Browserbase Project ID is missing.");
  }

  return { apiKey, projectId };
}

function getDefaultProxySettings(): ProxyConfig[] | boolean {
  // By default, don't use proxies unless explicitly configured
  const useProxies = process.env.USE_PROXIES === 'true';
  if (!useProxies) return false;
  
  // Return a default US-based proxy if enabled but not configured
  return [{
    type: "browserbase",
    geolocation: {
      country: "US"
    }
  }];
}

function createBrowserSettings(options: ScreenshotOptions): BrowserSettings {
  return {
    fingerprint: {
      screen: {
        maxWidth: VIEWPORT_WIDTH,
        maxHeight: VIEWPORT_HEIGHT,
        minWidth: VIEWPORT_WIDTH,
        minHeight: VIEWPORT_HEIGHT,
      },
    },
    viewport: {
      width: VIEWPORT_WIDTH,
      height: VIEWPORT_HEIGHT,
    },
    solveCaptchas: options.solveCaptchas !== false,
  };
}

async function getRawScreenshot(
  targetUrl: string,
  requestSessionId: string,
  options: ScreenshotOptions = {}
): Promise<RawScreenshotResult> {
  const { apiKey, projectId } = validateBrowserbaseCredentials();
  const bb = new Browserbase({ apiKey });
  let browser: Browser | null = null;
  let browserbaseSessionId: string | undefined;

  try {
    console.log(
      `[screenshotService] [${requestSessionId}] Creating Browserbase session for URL: ${targetUrl}`
    );

    const browserSettings = createBrowserSettings(options);
    const session = await bb.sessions.create({
      projectId,
      browserSettings,
      proxies: options.proxies !== undefined ? options.proxies : getDefaultProxySettings(),
    });

    browserbaseSessionId = session.id;
    console.log(
      `[screenshotService] [${requestSessionId}] Browserbase session ${browserbaseSessionId} created. Connecting...`
    );

    browser = await connectToBrowser(session.connectUrl);

    console.log(
      `[screenshotService] [${requestSessionId}] Connected to Browserbase session ${browserbaseSessionId}.`
    );

    if (!browser.isConnected()) {
      throw new BrowserConnectionError("Browser disconnected immediately after connection");
    }

    const defaultContext = browser.contexts()[0];
    const page: Page = defaultContext.pages()[0] || (await defaultContext.newPage());

    await setupPage(page, requestSessionId, options);

    console.log(
      `[screenshotService] [${requestSessionId}] Navigating to ${targetUrl} in session ${browserbaseSessionId}`
    );
    await page.setViewportSize({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });

    await page.goto(targetUrl, {
      waitUntil: "networkidle",
      timeout: PAGE_GOTO_TIMEOUT,
    });

    await page.waitForTimeout(2000);

    const screenshotBuffer = await page.screenshot();
    console.log(
      `[screenshotService] [${requestSessionId}] Raw screenshot taken for ${targetUrl}. Size: ${screenshotBuffer.length} bytes.`
    );

    return {
      buffer: screenshotBuffer,
      sessionId: browserbaseSessionId,
    };
  } catch (error) {
    console.error(
      `[screenshotService] [${requestSessionId}] Error getting raw screenshot for ${targetUrl} with Browserbase:`,
      error
    );
    throw error;
  } finally {
    await cleanupResources(browser, browserbaseSessionId, bb, projectId, requestSessionId);
  }
}

async function connectToBrowser(connectUrl: string): Promise<Browser> {
  const browserPromise = chromium.connectOverCDP(connectUrl);
  const timeoutPromise = new Promise<Browser>((_, reject) => {
    setTimeout(
      () => reject(new BrowserConnectionError("Browser connection timed out")),
      BROWSER_CONNECT_TIMEOUT
    );
  });

  return Promise.race([browserPromise, timeoutPromise]);
}

async function setupPage(page: Page, requestSessionId: string, options: ScreenshotOptions): Promise<void> {
  console.log(`[screenshotService] [${requestSessionId}] Initializing adblocker...`);
  const blocker = await PlaywrightBlocker.fromPrebuiltAdsAndTracking(fetch);
  await blocker.enableBlockingInPage(page);
  console.log(`[screenshotService] [${requestSessionId}] Adblocker enabled.`);

  if (options.solveCaptchas !== false) {
    page.on("console", (msg) => {
      if (msg.text() === "browserbase-solving-started") {
        console.log(`[screenshotService] [${requestSessionId}] CAPTCHA solving in progress...`);
      } else if (msg.text() === "browserbase-solving-finished") {
        console.log(`[screenshotService] [${requestSessionId}] CAPTCHA solving completed.`);
      }
    });
  }
}

async function cleanupResources(
  browser: Browser | null,
  browserbaseSessionId: string | undefined,
  bb: Browserbase,
  projectId: string,
  requestSessionId: string
): Promise<void> {
  if (browser) {
    try {
      console.log(
        `[screenshotService] [${requestSessionId}] Closing browser connection for session ${browserbaseSessionId}.`
      );
      await browser.close();
    } catch (closeError) {
      console.error(
        `[screenshotService] [${requestSessionId}] Error closing browser:`,
        closeError
      );
    }
  }
  
  if (browserbaseSessionId) {
    try {
      const hasMoreItems = queueManager.hasQueuedItems();
      if (!hasMoreItems) {
        await bb.sessions.update(browserbaseSessionId, {
          status: "REQUEST_RELEASE",
          projectId,
        });
        console.log(
          `[screenshotService] [${requestSessionId}] Browserbase session ${browserbaseSessionId} released - no more items in queue.`
        );
      } else {
        console.log(
          `[screenshotService] [${requestSessionId}] Keeping Browserbase session ${browserbaseSessionId} alive for queued items.`
        );
      }
    } catch (terminateError) {
      console.error(
        `[screenshotService] [${requestSessionId}] Error managing Browserbase session:`,
        terminateError
      );
    }
    console.log(
      `[screenshotService] [${requestSessionId}] Session ${browserbaseSessionId} processing finished. View replay at https://browserbase.com/sessions/${browserbaseSessionId}`
    );
  }
}

export async function takeScreenshotWithBrowserbase(
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

    const { buffer: rawBuffer, sessionId } = await getRawScreenshot(
      targetUrl,
      requestSessionId,
      options
    );

    console.log(
      `[screenshotService] [${requestSessionId}] Generating styled image for ${targetUrl}, session: ${sessionId}`
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
      sessionId,
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

function logError(error: unknown, startTime: number, requestSessionId: string, targetUrl: string): void {
  const totalTime = Date.now() - startTime;
  console.error(
    `[screenshotService] [${requestSessionId}] Error taking screenshot for ${targetUrl} after ${totalTime}ms:`,
    error
  );
}
