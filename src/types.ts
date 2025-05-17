import type { Browser } from "playwright-core";

export type BrowserSession = {
  id: string;
  browser: Browser | null;
  status: "idle" | "busy" | "launching" | "terminating" | "failed";
  lastUsed: number;
};

export type BrowserSessionMeta = {
  id: string;
  status: "idle" | "busy" | "launching" | "terminating" | "failed";
  lastUsed: number;
};

export type QueuedRequest = {
  id: string;
  targetUrl: string;
  enqueueTime: number;
};

export interface CaptchaSolveResult {
  solved: boolean;
  error?: string;
}
