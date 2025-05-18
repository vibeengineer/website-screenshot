import PQueue from "p-queue";
import type { Logger } from "pino";
import { QueueTimeoutError } from "../errors/index.js";
import type { ScreenshotService } from "../screenshot/index.js";

export type QueueManager = {
  // biome-ignore lint/suspicious/noConfusingVoidType: <explanation>
  enqueue: (url: string) => Promise<{ buffer: void | Buffer; sessionId: string }>;
  hasQueued: () => boolean;
};

export function createQueueManager({
  concurrency,
  screenshotService,
  logger,
  timeout,
}: {
  concurrency: number;
  screenshotService: ScreenshotService;
  logger: Logger;
  timeout: number;
}): QueueManager {
  const queue = new PQueue({ concurrency });

  const enqueue = async (url: string) => {
    const sessionId = crypto.randomUUID();
    logger.debug({ url, sessionId }, "queued screenshot request");

    const jobPromise = queue.add(() => screenshotService.capture(url, { sessionId }));
    const timer = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new QueueTimeoutError("job timed out")), timeout)
    );

    const buffer = await Promise.race([jobPromise, timer]);
    return { buffer, sessionId };
  };

  const hasQueued = () => queue.size > 0 || queue.pending > 0;

  return { enqueue, hasQueued };
}
