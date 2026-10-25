import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { AppStatus } from '../types';
const callbacks = new Set<(status: AppStatus) => void>();
const listening = listen<AppStatus>('status', event => { for (const callback of callbacks) callback(event.payload); });
const request = <T>(method: string, ...args: unknown[]) => invoke<T>('bridge', { method, args });
window.wechatDot = {
  status: async () => { await listening; return request('status'); },
  backlog: () => request('backlog'),
  manageBacklog: (operation, selection) => request('manage-backlog', operation, selection),
  action: (name, value) => request('action', name, value),
  resize: height => { void request('resize', height, window.innerHeight).catch(console.warn); },
  onStatus: callback => { callbacks.add(callback); }
};
