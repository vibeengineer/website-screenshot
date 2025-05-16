import { DurableObject } from "cloudflare:workers";
import puppeteer, { type Page as PuppeteerPage } from "@cloudflare/puppeteer";
import { NoAvailableSessionError } from "./errors";
import type { BrowserSession, BrowserSessionMeta, QueuedRequest } from "./types";

/**
 * Durable Object that spins up to `MAX_CONCURRENT_BROWSER_SESSIONS` headless-
 * Chromium instances (via Puppeteer) and fulfils screenshot jobs.  The queue is
 * in-memory; only minimal session metadata is persisted for alarm-based
 * cleanup.  Each screenshot is post-processed through the **Images** binding make it
 * look like a loom/screenrecording with the screenshot superimposed on top of a video of the website.
 */
export class ScreenshotBrowserDO extends DurableObject<Env> {
  /* ───────────────────────────────────────── constants ───── */
  private readonly MINUTE = 60_000;
  private readonly VIEWPORT_WIDTH = 1304;
  private readonly VIEWPORT_HEIGHT = 910;
  private readonly MAX_CONCURRENT_BROWSER_SESSIONS = 2;
  private readonly SESSION_TTL_MS = 5 * this.MINUTE;
  private readonly LAUNCH_TIMEOUT_MS = this.MINUTE / 2;
  private readonly SCREENSHOT_TIMEOUT_MS = this.MINUTE;
  private readonly ALARM_INTERVAL_MS = this.MINUTE;
  private readonly QUEUE_TIMEOUT_MS = 30 * this.MINUTE;

  /* ───────────────────────────────────────── runtime state ───── */
  private sessions = new Map<string, BrowserSession>();
  private queue: QueuedRequest[] = [];
  private pending = new Map<
    string,
    { resolve: (v: ArrayBuffer) => void; reject: (e: unknown) => void }
  >();
  private processing = false;

  constructor(readonly ctx: DurableObjectState, readonly env: Env) {
    super(ctx, env);

    this.ctx.blockConcurrencyWhile(async () => {
      const stored: BrowserSessionMeta[] = (await this.ctx.storage.get("sessions")) || [];
      for (const meta of stored) {
        this.sessions.set(meta.id, {
          id: meta.id,
          browser: null,
          status: meta.status,
          lastUsed: meta.lastUsed,
        });
      }
      if ((await this.ctx.storage.getAlarm()) == null) {
        await this.ctx.storage.setAlarm(Date.now() + this.ALARM_INTERVAL_MS);
      }
    });
  }

  /* ───────────────────────────────────────── public API ───── */
  takeScreenshotJob(targetUrl: string): Promise<ArrayBuffer> {
    const id = crypto.randomUUID();
    this.queue.push({ id, targetUrl, enqueueTime: Date.now() });
    void this.kickoffQueue();
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  /* ───────────────────────────────────────── queue engine ───── */
  private async kickoffQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (true) {
        // drop stale jobs
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

        // acquire/launch browser session
        let session: BrowserSession;
        try {
          session = await this.getSession();
        } catch (e) {
          if (e instanceof NoAvailableSessionError) break; // all busy
          throw e;
        }

        const job = this.queue.shift();
        if (!job) break;
        void this.executeJob(session, job);
      }
    } finally {
      this.processing = false;
    }
  }

  /* ───────────────────────────────────── session lifecycle ───── */
  private async getSession(): Promise<BrowserSession> {
    // reuse idle, healthy browser
    for (const s of this.sessions.values()) {
      if (s.status === "idle" && s.browser?.connected) {
        try {
          const p = await s.browser.newPage();
          await p.close();
          s.lastUsed = Date.now();
          await this.saveSessionsMeta();
          return s;
        } catch {
          await this.cleanupSession(s.id, true);
        }
      }
    }

    if (this.sessions.size >= this.MAX_CONCURRENT_BROWSER_SESSIONS) {
      throw new NoAvailableSessionError("All sessions busy");
    }

    const id = crypto.randomUUID();
    const newSession: BrowserSession = {
      id,
      browser: null,
      status: "launching",
      lastUsed: Date.now(),
    };
    this.sessions.set(id, newSession);
    await this.saveSessionsMeta();

    try {
      newSession.browser = await this.withTimeout(
        puppeteer.launch(this.env.BROWSER),
        this.LAUNCH_TIMEOUT_MS,
        "Browser launch timed out"
      );
      newSession.status = "idle";
      newSession.lastUsed = Date.now();
      await this.saveSessionsMeta();
      return newSession;
    } catch (e) {
      await this.cleanupSession(id, true);
      throw e;
    }
  }

  /* ───────────────────────────────────────── job runner ───── */
  private async executeJob(session: BrowserSession, job: QueuedRequest): Promise<void> {
    session.status = "busy";
    await this.saveSessionsMeta();

    try {
      const result = await this.withTimeout(
        this.takeScreenshot(job.targetUrl, session),
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

  /* ───────────────────────── post-processing via Images ─────── */
  private async postProcess(bytes: ArrayBuffer): Promise<ArrayBuffer> {
    // 1. Turn raw screenshot into a ReadableStream for the Images binding
    const screenshotStream = new Blob([bytes]).stream();

    // 2. Get base & overlay PNGs from the ASSETS bucket
    const baseResp = await fetch("https://files.duckhou.se/website-screenshot/base.png");
    const overlayResp = await fetch("https://files.duckhou.se/website-screenshot/overlay.png");

    if (!baseResp.body || !overlayResp.body) {
      console.warn("postProcess: asset fetch failed, skipping overlay");
      return bytes;
    }

    // 3. Pipe through the Images binding
    const processedResp = (await this.env.IMAGES.input(baseResp.body) // <== ReadableStream
      .draw(screenshotStream, { top: 114, left: 108 }) // place screenshot
      .draw(overlayResp.body, { top: 0, left: 0 }) // second overlay
      .output({ format: "image/png" }) // choose output type
      .then((resp) => resp.image())) as ReadableStream<Uint8Array>; // resp.image() returns a ReadableStream

    // Convert the stream to ArrayBuffer
    return this.streamToArrayBuffer(processedResp);
  }

  /* ───────────────────────────────────────── screenshot ───── */
  private async takeScreenshot(url: string, session: BrowserSession): Promise<ArrayBuffer> {
    if (!session.browser) throw new Error("Browser not available");

    const page: PuppeteerPage = await session.browser.newPage();
    try {
      await page.setViewport({ width: this.VIEWPORT_WIDTH, height: this.VIEWPORT_HEIGHT });
      await page.goto(url, { waitUntil: "networkidle0", timeout: 60_000 });

      const puppeteerBuffer = await page.screenshot(); // This is a Buffer (Uint8Array-like)
      const rawBuf: ArrayBuffer = puppeteerBuffer.buffer as ArrayBuffer;
      return this.postProcess(rawBuf);
    } finally {
      await page.close();
    }
  }

  /* ───────────────────────────────────────── helpers ───── */
  private async withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, r) => setTimeout(() => r(new Error(msg) as unknown as T), ms)),
    ]);
  }

  private async saveSessionsMeta(): Promise<void> {
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

  // Helper method to convert ReadableStream to ArrayBuffer
  private async streamToArrayBuffer(stream: ReadableStream<Uint8Array>): Promise<ArrayBuffer> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let totalLength = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        totalLength += value.length;
      }
    }
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result.buffer;
  }

  /* ───────────────────────────────────────── alarm hook ───── */
  async alarm(): Promise<void> {
    for (const id of Array.from(this.sessions.keys())) {
      await this.cleanupSession(id);
    }
    void this.kickoffQueue();
    await this.ctx.storage.setAlarm(Date.now() + this.ALARM_INTERVAL_MS);
  }

  /* ───────────────────────────────────── fetch stub ───── */
  async fetch(): Promise<Response> {
    return new Response("Use RPC instead of HTTP fetch", { status: 405 });
  }
}
