import type { Buffer } from "node:buffer";
import { DurableObject } from "cloudflare:workers";
import puppeteer, { Browser, type Page as PuppeteerPage } from "@cloudflare/puppeteer";
import { NoAvailableSessionError } from "./errors";
import type { BrowserSession, BrowserSessionMeta, QueuedRequest } from "./types";

/**
 * Cloudflare‑compatible Durable Object that manages at most `MAX_SESSIONS`
 * headless‑Chromium instances and serves screenshot jobs.  **The request queue
 * is now kept purely *in‑memory* for maximum throughput; only lightweight
 * session metadata is persisted so alarms can clean up abandoned browsers.**
 */

export class ScreenshotBrowserDO extends DurableObject<Env> {
  /* ─────────────────────────────────────────── constants ───── */
  private readonly MINUTE = 60_000;
  private readonly MAX_CONCURRENT_BROWSER_SESSIONS = 2;
  private readonly SESSION_TTL_MS = 5 * this.MINUTE;
  private readonly LAUNCH_TIMEOUT_MS = this.MINUTE / 2;
  private readonly SCREENSHOT_TIMEOUT_MS = this.MINUTE;
  private readonly ALARM_INTERVAL_MS = this.MINUTE;
  private readonly QUEUE_TIMEOUT_MS = 30 * this.MINUTE;

  /* ────────────────────────────────────────── runtime state ───── */
  private sessions = new Map<string, BrowserSession>();
  private queue: QueuedRequest[] = [];
  private pending = new Map<
    string,
    {
      resolve: (v: ArrayBuffer | string) => void;
      reject: (e: unknown) => void;
    }
  >();
  private processing = false;

  constructor(readonly ctx: DurableObjectState, readonly env: Env) {
    super(ctx, env);

    this.ctx.blockConcurrencyWhile(async () => {
      // restore *session* metadata only (queue lives in memory)
      const stored: BrowserSessionMeta[] = (await this.ctx.storage.get("sessions")) || [];
      for (const meta of stored) {
        this.sessions.set(meta.id, {
          id: meta.id,
          browser: null, // resurrect on demand
          status: meta.status,
          lastUsed: meta.lastUsed,
        });
      }

      // schedule periodic cleanup
      if ((await this.ctx.storage.getAlarm()) == null) {
        await this.ctx.storage.setAlarm(Date.now() + this.ALARM_INTERVAL_MS);
      }
    });
  }

  /* ─────────────────────────────────────────── public API ───── */
  /** RPC method; returns an ArrayBuffer (PNG) or R2 key, depending on `directOutput`. */
  takeScreenshotJob(targetUrl: string, directOutput = false): Promise<ArrayBuffer | string> {
    const id = crypto.randomUUID();
    this.queue.push({ id, targetUrl, directOutput, enqueueTime: Date.now() });
    void this.kickoffQueue();

    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  /* ─────────────────────────────────────── queue engine ───── */
  private async kickoffQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      // eslint‑disable‑next‑line no‑constant‑condition
      while (true) {
        // prune expired jobs
        while (
          this.queue.length &&
          Date.now() - this.queue[0].enqueueTime > this.QUEUE_TIMEOUT_MS
        ) {
          const stale = this.queue.shift();
          if (!stale) break;
          this.pending.get(stale.id)?.reject(new Error("Job timed out in queue"));
          this.pending.delete(stale.id);
        }
        if (this.queue.length === 0) break;

        // acquire session
        let session: BrowserSession;
        try {
          session = await this.getSession();
        } catch (e) {
          if (e instanceof NoAvailableSessionError) break; // all busy; wait for alarm
          throw e;
        }

        // execute next job without awaiting so loop can continue if capacity remains
        const job = this.queue.shift();
        if (!job) break;
        void this.executeJob(session, job);
      }
    } finally {
      this.processing = false;
    }
  }

  /* ─────────────────────────────────── session lifecycle ───── */
  private async getSession(): Promise<BrowserSession> {
    // reuse healthy idle browser
    for (const s of this.sessions.values()) {
      if (s.status === "idle" && s.browser?.connected) {
        try {
          const test = await s.browser.newPage();
          await test.close();
          s.lastUsed = Date.now();
          await this.saveSessionsMeta();
          return s;
        } catch {
          await this.cleanupSession(s.id, true);
        }
      }
    }

    // spawn new if under limit
    if (this.sessions.size >= this.MAX_CONCURRENT_BROWSER_SESSIONS) {
      throw new NoAvailableSessionError("All sessions busy");
    }

    const id = crypto.randomUUID();
    const session: BrowserSession = {
      id,
      browser: null,
      status: "launching",
      lastUsed: Date.now(),
    };
    this.sessions.set(id, session);
    await this.saveSessionsMeta();

    try {
      session.browser = await this.withTimeout(
        puppeteer.launch(this.env.BROWSER),
        this.LAUNCH_TIMEOUT_MS,
        "Browser launch timed out"
      );
      session.status = "idle";
      session.lastUsed = Date.now();
      await this.saveSessionsMeta();
      return session;
    } catch (err) {
      await this.cleanupSession(id, true);
      throw err;
    }
  }

  /* ───────────────────────────────────── job runner ───── */
  private async executeJob(session: BrowserSession, job: QueuedRequest): Promise<void> {
    session.status = "busy";
    await this.saveSessionsMeta();

    try {
      const result = await this.withTimeout(
        this.takeScreenshot(job.targetUrl, session, job.directOutput),
        this.SCREENSHOT_TIMEOUT_MS,
        "Screenshot timed out"
      );
      this.pending.get(job.id)?.resolve(result);
    } catch (e) {
      this.pending.get(job.id)?.reject(e);
      throw e;
    } finally {
      this.pending.delete(job.id);
      session.status = "idle";
      session.lastUsed = Date.now();
      await this.saveSessionsMeta();
      void this.kickoffQueue();
    }
  }

  /* ───────────────────────────────────────── screenshot ───── */
  private async takeScreenshot(
    url: string,
    session: BrowserSession,
    direct: boolean
  ): Promise<ArrayBuffer | string> {
    if (!session.browser) throw new Error("Browser not available");
    const page: PuppeteerPage = await session.browser.newPage();

    try {
      await page.setViewport({ width: 1920, height: 1080 });
      await page.goto(url, { waitUntil: "networkidle0", timeout: 60_000 });
      const buf: Buffer = await page.screenshot();
      if (direct) return buf.buffer as ArrayBuffer;

      const host = new URL(url).hostname.replace(/[^a-z0-9_.-]/gi, "_").slice(0, 100);
      const key = `screenshots/${Date.now()}_${host}.png`;
      await this.env.SCREENSHOTS_BUCKET.put(key, buf, {
        httpMetadata: { contentType: "image/png" },
      });
      return key;
    } finally {
      await page.close();
    }
  }

  /* ───────────────────────────────────────── helpers ───── */
  private async withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
    ]);
  }

  private async saveSessionsMeta() {
    const meta: BrowserSessionMeta[] = Array.from(this.sessions.values()).map(
      ({ id, status, lastUsed }) => ({ id, status, lastUsed })
    );
    await this.ctx.storage.put("sessions", meta);
  }

  private async cleanupSession(id: string, force = false): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;

    const idle = Date.now() - s.lastUsed;
    const shouldClean =
      force ||
      s.status === "terminating" ||
      s.status === "failed" ||
      (s.status === "idle" && idle > this.SESSION_TTL_MS) ||
      (s.browser && !s.browser.connected);
    if (!shouldClean) return;

    try {
      await s.browser?.close();
    } catch {}
    this.sessions.delete(id);
    await this.saveSessionsMeta();
  }

  /* ───────────────────────────────────────── alarm hook ───── */
  async alarm(): Promise<void> {
    for (const id of Array.from(this.sessions.keys())) await this.cleanupSession(id);
    void this.kickoffQueue();
    await this.ctx.storage.setAlarm(Date.now() + this.ALARM_INTERVAL_MS);
  }

  /* ───────────────────────────────────────── fetch stub ───── */
  async fetch(): Promise<Response> {
    return new Response("Use RPC instead of HTTP fetch", { status: 405 });
  }
}
