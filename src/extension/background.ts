import defaults from '../../config/defaults.json';
import { dotPageAction, pageResult } from '../dot/page';

const config = defaults.dot;
let socket: WebSocket | undefined;
let connecting: Promise<void> | undefined;
let tabId: number | undefined;

async function dotTab(active = false): Promise<chrome.tabs.Tab> {
  tabId ??= (await chrome.storage.session.get('dotTab')).dotTab as number | undefined;
  let tab = tabId === undefined ? undefined : await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab || !tab.url?.startsWith(new URL(config.homeUrl).origin + '/')) {
    tab = await chrome.tabs.create({ url: config.homeUrl, active });
    tabId = tab.id;
    await chrome.storage.session.set({ dotTab: tabId });
  } else if (active) await chrome.tabs.update(tab.id!, { active: true });
  if (active && tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
  const end = Date.now() + config.requestTimeoutMs;
  while (tab.status !== 'complete') {
    if (Date.now() > end) throw new Error('ChatGPT 页面仍在加载，请打开标签页检查。');
    await new Promise(resolve => setTimeout(resolve, 100));
    tab = await chrome.tabs.get(tab.id!);
  }
  return tab;
}
async function handle(action: string, args: any): Promise<any> {
  const tab = await dotTab(action === 'show');
  if (action === 'show') return;
  if (action === 'navigate') {
    if (new URL(args.url).origin !== new URL(config.homeUrl).origin) throw new Error('只能打开 ChatGPT。');
    await chrome.tabs.update(tab.id!, { url: args.url });
    await dotTab(); return;
  }
  if (action !== 'run') throw new Error('未知的扩展操作。');
  const result = await chrome.scripting.executeScript({ target: { tabId: tab.id! }, world: 'MAIN', func: dotPageAction, args: [args.action, args.args] });
  if (!result.length) throw new Error('无法连接 dot 标签页。');
  return pageResult(result[0].result);
}
async function connect(): Promise<void> {
  if (socket?.readyState === WebSocket.OPEN) return;
  if (connecting) return connecting;
  connecting = (async () => {
    const ws = socket = new WebSocket(`ws://127.0.0.1:${config.extension.port}`);
    ws.onmessage = async event => {
      const request = JSON.parse(event.data);
      if (request.type === 'ping') { ws.send('{"type":"pong"}'); return; }
      try {
        const result = await handle(request.action, request.args);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: request.id, result }));
      } catch (e) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: request.id, error: (e as Error).message })); }
    };
    ws.onclose = () => { if (socket === ws) socket = undefined; void chrome.action.setBadgeText({ text: '' }); };
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => { void chrome.action.setBadgeText({ text: 'ON' }); resolve(); };
      ws.onerror = () => { ws.close(); reject(new Error('先打开 WeChat Dot，再点程序里的「连接 Chrome」。')); };
    });
  })();
  try { await connecting; } finally { connecting = undefined; }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message.type === 'network') {
    if (sender.tab?.id === tabId && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'event', method: message.method, params: message.params }));
    return;
  }
  if (sender.url !== chrome.runtime.getURL('popup.html')) return;
  void (async () => {
    if (message.type === 'connect') { await chrome.storage.local.set({ enabled: true }); await dotTab(true); await connect(); }
    if (message.type === 'disconnect') { await chrome.storage.local.set({ enabled: false }); socket?.close(); }
    return { connected: socket?.readyState === WebSocket.OPEN };
  })().then(respond, e => respond({ error: e.message }));
  return true;
});
async function resume(): Promise<void> { if ((await chrome.storage.local.get('enabled')).enabled) await connect().catch(() => {}); }
chrome.runtime.onStartup.addListener(() => { void resume(); });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'reconnect') void resume(); });
void chrome.alarms.create('reconnect', { periodInMinutes: 1 });
void resume();
