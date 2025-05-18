export class BaseError extends Error {
  constructor(message: string, public code: string) {
    super(message);
  }
}

export class QueueTimeoutError extends BaseError {
  constructor(msg = "queue timeout") {
    super(msg, "QUEUE_TIMEOUT");
  }
}

export class BrowserConnectionError extends BaseError {
  constructor(msg = "browser connection error") {
    super(msg, "BROWSER_CONNECTION");
  }
}

export class ScreenshotTimeoutError extends BaseError {
  constructor(msg = "screenshot timeout") {
    super(msg, "SCREENSHOT_TIMEOUT");
  }
}
