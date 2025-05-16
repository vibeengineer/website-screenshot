import type { Browser } from "@cloudflare/puppeteer";

export type BrowserSession = {
  id: string; // Our internal ID for this session slot
  browser: Browser | null;
  status: "idle" | "busy" | "launching" | "terminating" | "failed";
  lastUsed: number;
};

// Helper type for serializing session metadata
export type BrowserSessionMeta = {
  id: string;
  status: "idle" | "busy" | "launching" | "terminating" | "failed";
  lastUsed: number;
};

export type QueuedRequest = {
  id: string;
  targetUrl: string;
  enqueueTime: number;
  // directOutput: boolean; // To indicate if direct image output is requested
};
