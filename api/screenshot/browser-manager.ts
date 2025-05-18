import ProxyRouterMod from "@extra/proxy-router";
import type { Logger } from "pino";
import playwright from "playwright";
import { addExtra } from "playwright-extra";
import RecaptchaMod from "puppeteer-extra-plugin-recaptcha";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { BrowserConnectionError } from "../errors/index.js";
import type { Env } from "../utils/env.js";
import { unwrap } from "../utils/unwrap-cjs-default.js";

const RecaptchaPlugin = unwrap(RecaptchaMod);
const ProxyRouter = unwrap(ProxyRouterMod);

export type BrowserManager = {
  getBrowser(): Promise<import("playwright-core").Browser>;
  closeAll(): Promise<void>;
};

export function createBrowserManager(env: Env, logger: Logger): BrowserManager {
  /* build Chromium with Playwright-Extra plugins */
  const chromium = addExtra(playwright.chromium);
  chromium.use(StealthPlugin());

  if (env.CAPTCHA_TOKEN) {
    chromium.use(
      RecaptchaPlugin({
        provider: { id: "2captcha", token: env.CAPTCHA_TOKEN },
      })
    );
  }

  if (env.PROXY_DEFAULT) {
    chromium.use(
      ProxyRouter({
        proxies: { DEFAULT: env.PROXY_DEFAULT },
      })
    );
  }

  let connected: import("playwright-core").Browser | null = null;
  let retries = 0;

  async function getBrowser() {
    if (env.ENABLE_KEEP_ALIVE && connected?.isConnected()) return connected;

    try {
      connected = await chromium.connectOverCDP(env.BROWSERLESS_WS, {
        timeout: 10_000,
      });
      retries = 0;
      return connected;
    } catch (err) {
      if (retries++ < 2) {
        logger.warn({ err, retries }, "retrying browserless connection");
        await new Promise((r) => setTimeout(r, 1_000));
        return getBrowser();
      }
      logger.error(err, "Browserless connection failed");
      throw new BrowserConnectionError("cannot connect to browserless");
    }
  }

  return {
    getBrowser,
    closeAll: () => connected?.close() ?? Promise.resolve(),
  };
}
