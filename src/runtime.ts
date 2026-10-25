import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';

export interface BrowserRuntime {
  userDirectory: string;
  extensionDirectory: string;
  fetch: typeof globalThis.fetch;
  createEmbeddedWindow?: (options: BrowserWindowConstructorOptions) => BrowserWindow;
}
let current: BrowserRuntime | undefined;
export function configureRuntime(runtime: BrowserRuntime): void { current = runtime; }
export function browserRuntime(): BrowserRuntime {
  if (!current) throw new Error('程序尚未准备完成，请重新打开 WeChat Dot。');
  return current;
}
