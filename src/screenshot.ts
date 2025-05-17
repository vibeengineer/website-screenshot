import Browserbase from "@browserbasehq/sdk";
import type { APIPromise } from "@browserbasehq/sdk/src/core.js";
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

// Track active sessions for reuse
let activeSession: { id: string; connectUrl: string; lastUsed: number } | null = null;

// Check if keep-alive is enabled via environment variable
const ENABLE_KEEP_ALIVE = process.env.ENABLE_KEEP_ALIVE === "true";

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
  const useProxies = process.env.USE_PROXIES === "true";
  if (!useProxies) return false;

  // Return a default US-based proxy if enabled but not configured
  return [
    {
      type: "browserbase",
      geolocation: {
        country: "US",
      },
    },
  ];
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
  let sessionResponse: Browserbase.Sessions.SessionCreateResponse;
  let usingExistingSession = false;
  let lastQueueLogTime = 0;

  try {
    // Only try to reuse sessions if keep-alive is enabled
    if (ENABLE_KEEP_ALIVE && activeSession && queueManager.hasQueuedItems()) {
      try {
        console.log(
          `[screenshotService] [${requestSessionId}] Reusing existing Browserbase session ${activeSession.id} for URL: ${targetUrl}`
        );

        browserbaseSessionId = activeSession.id;
        browser = await connectToBrowser(activeSession.connectUrl);
        usingExistingSession = true;

        console.log(
          `[screenshotService] [${requestSessionId}] Successfully reconnected to session ${browserbaseSessionId}`
        );
      } catch (reconnectError) {
        console.error(
          `[screenshotService] [${requestSessionId}] Failed to reuse existing session, creating new one:`,
          reconnectError
        );
        activeSession = null; // Reset the active session since we couldn't reconnect
      }
    }

    // Create a new session if we couldn't reuse an existing one
    if (!browser) {
      console.log(
        `[screenshotService] [${requestSessionId}] Creating new Browserbase session for URL: ${targetUrl}`
      );

      const browserSettings = createBrowserSettings(options);

      // Only use keep-alive when enabled and there are items in the queue
      const hasQueuedItems = queueManager.hasQueuedItems();
      const useKeepAlive = ENABLE_KEEP_ALIVE && hasQueuedItems;
      
      const sessionParams: Browserbase.Sessions.SessionCreateParams = {
        projectId,
        browserSettings,
        proxies: options.proxies !== undefined ? options.proxies : getDefaultProxySettings(),
      };
      
      // Only add keepAlive parameter if enabled
      if (useKeepAlive) {
        sessionParams.keepAlive = true;
      }
      
      sessionResponse = await bb.sessions.create(sessionParams);

      browserbaseSessionId = sessionResponse.id;

      // Only log new session creation, not every queue item
      if (Date.now() - lastQueueLogTime > 5000 && hasQueuedItems) {
        console.log(
          `[screenshotService] [${requestSessionId}] Created Browserbase session ${browserbaseSessionId} with keep-alive. Queued items: ${
            hasQueuedItems ? "Yes" : "No"
          }`
        );
        lastQueueLogTime = Date.now();
      }

      // SessionCreateResponse has connectUrl property
      browser = await connectToBrowser(sessionResponse.connectUrl);

      // Store session for potential reuse if keep-alive is enabled
      if (ENABLE_KEEP_ALIVE && useKeepAlive && hasQueuedItems) {
        activeSession = {
          id: sessionResponse.id,
          connectUrl: sessionResponse.connectUrl,
          lastUsed: Date.now(),
        };
      }
    }

    if (!browser.isConnected()) {
      throw new BrowserConnectionError("Browser disconnected immediately after connection");
    }

    const defaultContext = browser.contexts()[0];
    const page: Page = defaultContext.pages()[0] || (await defaultContext.newPage());

    await setupPage(page, requestSessionId, options);
    await page.setViewportSize({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });

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

    // Ensure scrollbar is hidden after page load
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

    await page.waitForTimeout(1000);

    // Add timeout to screenshot operation
    const screenshotPromise = page.screenshot();
    const timeoutPromise = new Promise<Buffer>((_, reject) => {
      setTimeout(() => reject(new ScreenshotTimeoutError("Screenshot capture timed out")), 5000);
    });

    const screenshotBuffer = await Promise.race([screenshotPromise, timeoutPromise]);

    // Update last used time for session
    if (activeSession && browserbaseSessionId === activeSession.id) {
      activeSession.lastUsed = Date.now();
    }

    if (!browserbaseSessionId) {
      throw new Error("No browserbase session ID available");
    }
    
    return {
      buffer: screenshotBuffer,
      sessionId: browserbaseSessionId,
    };
  } catch (error) {
    console.error(
      `[screenshotService] [${requestSessionId}] Error getting raw screenshot for ${targetUrl}:`,
      error
    );

    // If this was a reused session that failed, clear it
    if (usingExistingSession && activeSession) {
      console.log(`[screenshotService] [${requestSessionId}] Clearing failed reused session`);
      activeSession = null;
    }

    throw error;
  } finally {
    // Only keep session alive if enabled and we have an active session with queued items
    if (!ENABLE_KEEP_ALIVE || !activeSession || !queueManager.hasQueuedItems()) {
      await cleanupResources(browser, browserbaseSessionId, bb, projectId, requestSessionId);
    } else if (browser) {
      // Just close the browser connection but keep the session alive (keep-alive is enabled)
      try {
        await browser.close();
      } catch (closeError) {
        console.error(
          `[screenshotService] [${requestSessionId}] Error closing browser:`,
          closeError
        );
      }
    }
  }
}

async function connectToBrowser(connectUrl: string, retryAttempts = 2): Promise<Browser> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= retryAttempts; attempt++) {
    try {
      if (attempt > 0) {
        console.log(
          `[screenshotService] Retrying browser connection (attempt ${attempt}/${retryAttempts})`
        );
        // Small delay before retry
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

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
  console.log(`[screenshotService] [${requestSessionId}] Initializing adblocker...`);
  const blocker = await PlaywrightBlocker.fromPrebuiltAdsAndTracking(fetch);
  await blocker.enableBlockingInPage(page);
  console.log(`[screenshotService] [${requestSessionId}] Adblocker enabled.`);

  // Add initial scrollbar hiding styles
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
  console.log(`[screenshotService] [${requestSessionId}] Initial scrollbar hiding styles added.`);

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
      console.error(`[screenshotService] [${requestSessionId}] Error closing browser:`, closeError);
    }
  }

  if (browserbaseSessionId) {
    try {
      const hasMoreItems = queueManager.hasQueuedItems();

      // If keep-alive is enabled, we have an active session and there are more items in the queue, keep it alive
      if (ENABLE_KEEP_ALIVE && activeSession && activeSession.id === browserbaseSessionId && hasMoreItems) {
        // Don't log every time, only if this is the first item or last processed
        console.log(
          `[screenshotService] [${requestSessionId}] Keeping keep-alive session ${browserbaseSessionId} active for queued items.`
        );

        // Trigger the queue processor to handle the next item
        setTimeout(() => {
          void queueManager.processNextQueueItem();
        }, 100);
      } else if (!hasMoreItems || !activeSession || activeSession.id !== browserbaseSessionId) {
        // Release the session if there are no more items or this isn't our active session
        await bb.sessions.update(browserbaseSessionId, {
          status: "REQUEST_RELEASE",
          projectId,
        });

        // If this was our active session, clear it
        if (activeSession && activeSession.id === browserbaseSessionId) {
          activeSession = null;
        }

        console.log(
          `[screenshotService] [${requestSessionId}] Browserbase session ${browserbaseSessionId} released.`
        );
      }
    } catch (terminateError) {
      console.error(
        `[screenshotService] [${requestSessionId}] Error managing Browserbase session:`,
        terminateError
      );

      // If there was an error, clear the active session reference
      if (activeSession && activeSession.id === browserbaseSessionId) {
        activeSession = null;
      }
    }

    // Only log this for the final release
    if (!activeSession || activeSession.id !== browserbaseSessionId) {
      console.log(
        `[screenshotService] [${requestSessionId}] Session ${browserbaseSessionId} processing finished. View replay at https://browserbase.com/sessions/${browserbaseSessionId}`
      );
    }
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
