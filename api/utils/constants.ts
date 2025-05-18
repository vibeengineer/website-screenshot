export const VIEWPORT_WIDTH = 1304;
export const VIEWPORT_HEIGHT = 910;
export const PAGE_GOTO_TIMEOUT = 60_000;

export async function withTimeout<T>(promise: Promise<T>, ms: number, msg: string) {
  const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(msg)), ms));
  return Promise.race([promise, timer]);
}
