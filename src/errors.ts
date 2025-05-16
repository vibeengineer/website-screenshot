export class NoAvailableSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoAvailableSessionError";
  }
}
