export function unwrap<T extends (...args: any[]) => any>(mod: any): T {
  return (mod?.default ?? mod) as T;
}
