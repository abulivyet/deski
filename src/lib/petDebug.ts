const PREFIX = "[Deski]";

export function petLog(...args: unknown[]): void {
  console.log(PREFIX, ...args);
}

export function petWarn(...args: unknown[]): void {
  console.warn(PREFIX, ...args);
}

export function petError(...args: unknown[]): void {
  console.error(PREFIX, ...args);
}
