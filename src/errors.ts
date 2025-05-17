export class NoAvailableSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoAvailableSessionError";
  }
}

export class ScreenshotTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScreenshotTimeoutError";
  }
}

export class BrowserConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserConnectionError";
  }
}

export class QueueTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueTimeoutError";
  }
}
