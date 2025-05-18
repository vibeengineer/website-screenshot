import type { Logger } from "pino";
import { type Browser, chromium } from "playwright-core";
import { BrowserConnectionError } from "../errors/index.js";
import type { Env } from "../utils/env.js";

export type BrowserManager = {
  getBrowser: () => Promise<Browser>;
  closeAll: () => Promise<void>;
};

export function createBrowserManager(env: Env, logger: Logger): BrowserManager {
  let active: Browser | null = null;

  const connect = async (): Promise<Browser> => {
    if (env.ENABLE_KEEP_ALIVE && active && active.isConnected()) return active;

    try {
      logger.debug({ ws: env.BROWSERLESS_WS }, "connecting to browserless");
      active = await chromium.connectOverCDP(env.BROWSERLESS_WS);
      return active;
    } catch (err) {
      throw new BrowserConnectionError("cannot connect to browserless");
    }
  };

  const closeAll = async () => {
    if (active) await active.close();
  };

  return { getBrowser: connect, closeAll };
}
