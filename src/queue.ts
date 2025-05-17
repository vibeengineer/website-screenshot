import { MAX_CONCURRENT_BROWSER_SESSIONS, QUEUE_TIMEOUT } from "./constants";
import { QueueTimeoutError } from "./errors";

export interface QueuedRequest {
  id: string;
  targetUrl: string;
  enqueueTime: number;
}

type PendingRequest = {
  resolve: (buffer: Buffer) => void;
  reject: (error: Error) => void;
  sessionId?: string;
};

export class ScreenshotQueueManager {
  private queue: QueuedRequest[] = [];
  private processing = false;
  private pendingRequests = new Map<string, PendingRequest>();
  private readonly activeSessions = new Set<string>();
  private _lastQueueLogTime = 0;

  hasQueuedItems(): boolean {
    return this.queue.length > 0;
  }

  queueScreenshotJob(targetUrl: string): Promise<{ buffer: Buffer; sessionId: string }> {
    const id = crypto.randomUUID();
    this.queue.push({ id, targetUrl, enqueueTime: Date.now() });

    const promise = new Promise<{ buffer: Buffer; sessionId: string }>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: (buffer) => {
          resolve({ buffer, sessionId: this.pendingRequests.get(id)?.sessionId || "" });
        },
        reject,
      });
    });

    void this.processQueue();
    return promise;
  }
  
  // Public method to process the next item in the queue
  processNextQueueItem(): void {
    void this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      await this.removeStaleJobs();
      
      if (this.queue.length === 0) return;

      if (!this.canProcessNewJob()) {
        // All slots busy, we'll process this queue item when a slot becomes available
        // Only log periodically to reduce noise
        const now = Date.now();
        if (!this._lastQueueLogTime || now - this._lastQueueLogTime > 5000) {
          console.log(`[queue] All ${MAX_CONCURRENT_BROWSER_SESSIONS} browser sessions busy. Queued jobs: ${this.queue.length}`);
          this._lastQueueLogTime = now;
        }
        return;
      }
      
      const job = this.queue.shift();
      if (job) {
        console.log(`[queue] Processing job for URL: ${job.targetUrl} (Queue size: ${this.queue.length})`);
        void this.executeJob(job);
      }
    } finally {
      this.processing = false;
      if (this.queue.length > 0) {
        setTimeout(() => void this.processQueue(), 100);
      }
    }
  }

  private async removeStaleJobs(): Promise<void> {
    while (this.queue.length && this.isJobStale(this.queue[0])) {
      const stale = this.queue.shift();
      if (!stale) break;
      
      this.rejectJob(stale.id, new QueueTimeoutError("Job timed out in queue"));
    }
  }

  private isJobStale(job: QueuedRequest): boolean {
    return Date.now() - job.enqueueTime > QUEUE_TIMEOUT;
  }

  private rejectJob(jobId: string, error: Error): void {
    this.pendingRequests.get(jobId)?.reject(error);
    this.pendingRequests.delete(jobId);
  }

  private canProcessNewJob(): boolean {
    return this.activeSessions.size < MAX_CONCURRENT_BROWSER_SESSIONS;
  }

  private async executeJob(job: QueuedRequest): Promise<void> {
    const sessionId = crypto.randomUUID();
    this.activeSessions.add(sessionId);

    const pendingRequest = this.pendingRequests.get(job.id);
    if (pendingRequest) {
      pendingRequest.sessionId = sessionId;
    }

    try {
      const result = await this.executeScreenshotJob(job.targetUrl, sessionId);
      this.pendingRequests.get(job.id)?.resolve(result);
    } catch (error) {
      this.pendingRequests
        .get(job.id)
        ?.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.pendingRequests.delete(job.id);
      this.activeSessions.delete(sessionId);
      void this.processQueue();
    }
  }

  executeScreenshotJob(targetUrl: string, sessionId: string): Promise<Buffer> {
    throw new Error("executeScreenshotJob must be implemented");
  }

  setScreenshotExecutor(executor: (targetUrl: string, sessionId: string) => Promise<Buffer>): void {
    this.executeScreenshotJob = executor;
  }
}

export const queueManager = new ScreenshotQueueManager();
