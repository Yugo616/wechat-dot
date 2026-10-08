import { _electron as electron, chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { buildExtension } from '../scripts/extension.mjs';
import { createServer as createTcpServer } from 'node:net';
const data = await mkdtemp(join(tmpdir(), 'wechat-dot-desktop-'));
let draftAttachment = true;
let draftPolls = 0, lastDraftPoll;
let deniedStatus = 0, dotRequests = 0;
let signedIn = true;
let breakSession = false;
const requests = [];
let incoming = [], sent = [], nativeSends = [], messages = [{ id: 'old', account_user_id: 'dot-member', content: { text: '不应重发的历史' } }];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/fixture/draft' && !url.pathname.endsWith('getupdates')) { requests.push({ at: new Date().toISOString(), method: req.method, path: url.pathname }); if (requests.length > 30) requests.shift(); }
  const parts = []; for await (const b of req) parts.push(b);
  const body = Buffer.concat(parts).toString();
  res.setHeader('Content-Type', 'application/json');
  if (url.pathname.startsWith('/backend-api/')) {
    dotRequests++;
    if (deniedStatus) { res.statusCode = deniedStatus; return res.end('{"error":"access denied"}'); }
  }
  if (url.pathname === '/ilink/bot/get_bot_qrcode') return res.end(JSON.stringify({ qrcode: 'fixture-qr', qrcode_img_content: base }));
  if (url.pathname === '/ilink/bot/get_qrcode_status') return res.end(JSON.stringify({ status: 'confirmed', bot_token: 'fixture-weixin', ilink_bot_id: 'fixture-bot', ilink_user_id: 'fixture-owner', baseurl: base }));
  if (url.pathname === '/ilink/bot/getupdates') { const msgs = incoming.splice(0); return res.end(JSON.stringify({ ret: 0, msgs, get_updates_buf: 'cursor' })); }
  if (url.pathname === '/ilink/bot/sendmessage') { sent.push(JSON.parse(body).msg); return res.end('{"ret":0}'); }
  if (url.pathname === '/fixture/draft') { draftPolls++; lastDraftPoll = { at: new Date().toISOString(), attachment: draftAttachment }; return res.end(JSON.stringify({attachment:draftAttachment})); }
  if (url.pathname === '/api/auth/session') {
    if (breakSession) return res.destroy();
    return res.end(JSON.stringify(signedIn ? { accessToken: 'fixture-chatgpt', user: { id: 'fixture-user' } } : {}));
  }
  if (url.pathname === '/backend-api/tbo/primary') return res.end(JSON.stringify({ selection: { available: true, thread_id: 'thread' }, profile: { id: 'fixture-dot', display_name: '测试 dot', messaging_room_id: 'room' } }));
  if (url.pathname === '/backend-api/messaging/rooms/room') return res.end(JSON.stringify({ id: 'room', members: [{ aeon_id: 'fixture-dot', account_user_id: 'dot-member' }] }));
  if (url.pathname === '/backend-api/messaging/rooms/room/messages') {
    if (req.method === 'POST') {
      const payload = JSON.parse(body); nativeSends.push(payload);
      const id = `user-${nativeSends.length}`;
      messages.push({ id, account_user_id: 'owner-member', request_id: payload.request_id, content: payload.content });
      messages.push({ id: `reply-${nativeSends.length}`, account_user_id: 'dot-member', content: { text: `收到：${payload.content.text}` } });
      return res.end(JSON.stringify({ id }));
    }
    let items = messages;
    if (url.searchParams.has('after')) items = items.slice(items.findIndex(m => m.id === url.searchParams.get('after')) + 1);
    else items = items.slice(-Number(url.searchParams.get('limit') || 50));
    return res.end(JSON.stringify({ items, next_cursor: null }));
  }
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><form><span id="attachment"><button type="button" aria-label="Remove file">private-draft.png</button></span><textarea id="prompt-textarea"></textarea><button type="button" data-testid="send-button" onclick="send()">Send</button></form><script>
    setInterval(async()=>{const s=await fetch("/fixture/draft").then(r=>r.json());if(!s.attachment)document.getElementById("attachment")?.remove();},50);
    async function send(){const text=document.querySelector('textarea').value;const request_id=crypto.randomUUID();await fetch('/backend-api/messaging/rooms/room/messages',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer fixture-chatgpt','ChatGPT-Account-Id':'fixture-account'},body:JSON.stringify({content:{text},request_id,idempotency_token:request_id})});document.querySelector('textarea').value='';}
  </script>`);
}).listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const dotConfig = { browser: process.env.WECHAT_DOT_TEST_BROWSER ?? 'embedded', homeUrl: base + '/', pollIntervalMs: 50, sendTimeoutMs: 4000 };
let extensionContext;
if (dotConfig.browser === 'extension') {
  const defaults = JSON.parse(await readFile('config/defaults.json', 'utf8'));
  const portProbe = createTcpServer().listen(0, '127.0.0.1'); await once(portProbe, 'listening');
  const port = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve));
  dotConfig.extension = { ...defaults.dot.extension, port };
  const directory = join(data, 'extension'); await buildExtension(directory, dotConfig);
  extensionContext = await chromium.launchPersistentContext(join(data, 'browser'), { channel: 'chromium', executablePath: process.env.WECHAT_DOT_TEST_CHROME, headless: true,
    args: [`--disable-extensions-except=${directory}`, `--load-extension=${directory}`] });
}
await writeFile(join(data, 'config.json'), JSON.stringify({ weixin: { baseUrl: base, retryDelayMs: 30, longPollTimeoutMs: 500 }, dot: dotConfig }));
let desktop, browserPort;
async function waitFor(test, label, timeout = 15000) { const end = Date.now() + timeout; while (!(await test())) { if (Date.now() > end) throw new Error(label); await new Promise(r => setTimeout(r, 50)); } }
async function setupVisible() {
  return desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')).isVisible());
}
async function reopenSetup() {
  await desktop.evaluate(({ app }) => { app.emit('second-instance', {}, [], process.cwd()); });
  await waitFor(setupVisible, 'A second launch did not reopen connection settings');
}
try {
  desktop = await electron.launch({ args: ['.'], env: { ...process.env, WECHAT_DOT_DATA: data } });
  const page = await desktop.firstWindow();
  await page.getByRole('button', { name: '微信扫码', exact: true }).click();
  await page.locator('#weixin-badge[data-status="ready"]').waitFor();
  if (extensionContext) {
    await desktop.evaluate(({ shell }) => { shell.openPath = async () => ''; });
    await page.getByRole('button', { name: '安装 Chrome 扩展', exact: true }).click();
  } else await page.getByRole('button', { name: '登录 ChatGPT', exact: true }).click();
  if (extensionContext) {
    const worker = extensionContext.serviceWorkers()[0] ?? await extensionContext.waitForEvent('serviceworker');
    const popup = await extensionContext.newPage();
    await popup.goto(new URL('popup.html', worker.url()).href);
    await popup.getByRole('button', { name: '连接 dot', exact: true }).click();
    await popup.locator('#detail').filter({ hasText: '已连接' }).waitFor();
    await popup.close();
  }
  if (process.env.WECHAT_DOT_TEST_BROWSER === 'external') await page.getByRole('button', { name: '登录完成，识别 dot' }).click();
  await page.locator('#dot-badge[data-status="ready"]').waitFor({timeout:45000});
  let managedPage, documentId;
  if (extensionContext) {
    managedPage = extensionContext.pages().find(p => p.url().startsWith(base));
    assert.equal(new URL(managedPage.url()).pathname, '/');
    documentId = await managedPage.evaluate(() => { history.pushState({}, '', '/dots/thread'); return window.fixtureDocumentId = crypto.randomUUID(); });
  }
  if (process.env.WECHAT_DOT_TEST_BROWSER === 'external') browserPort = (await readFile(join(data, 'ChatGPT Browser', 'DevToolsActivePort'), 'utf8')).split('\n')[0];
  await page.getByRole('button', { name: /开始连接/ }).click();
  await page.getByRole('button', { name: '暂停连接' }).waitFor();
  await waitFor(async () => !(await setupVisible()), 'Connected setup did not move to the tray');
  await reopenSetup();
  await desktop.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')).close(); });
  assert.equal(await setupVisible(), false, 'Closing settings should leave the bridge running');
  incoming.push({ message_id: 'wx-1', from_user_id: 'fixture-owner', message_type: 1, message_state: 2, context_token: 'reply-context', item_list: [{ type: 1, text_item: { text: '你好 dot' } }] });
  await waitFor(async () => nativeSends.length > 0 || (await page.evaluate(() => window.wechatDot.status())).problem?.includes('附件'), 'Composer was not inspected');
  assert.equal(nativeSends.length, 0, 'An attachment-only draft must not be submitted');
  const deliveryStarted = Date.now();
  draftAttachment = false;
  await waitFor(() => sent.length === 1, 'Native text loop did not deliver', 60000);
  console.log('FIXTURE DELIVERY MS', Date.now() - deliveryStarted);
  assert.equal(sent[0].item_list[0].text_item.text, '收到：你好 dot');
  assert.equal(nativeSends.length, 1);
  if (managedPage) assert.equal(await managedPage.evaluate(() => window.fixtureDocumentId), documentId, 'A dot opened by SPA navigation should work without a reload');
  await waitFor(async () => JSON.parse(await readFile(join(data, 'state.json'), 'utf8')).inbound[0]?.phase === 'done', 'Native send confirmation was lost after SPA navigation', 5000);
  incoming.push({ message_id: 'wx-1', from_user_id: 'fixture-owner', message_type: 1, message_state: 2, context_token: 'reply-context', item_list: [{ type: 1, text_item: { text: '你好 dot' } }] });
  await new Promise(r => setTimeout(r, 500));
  assert.equal(nativeSends.length, 1);
  incoming.push({ message_id: 'wx-2', from_user_id: 'fixture-owner', message_type: 1, message_state: 2, context_token: 'reply-context', item_list: [{ type: 1, text_item: { text: '接着聊' } }] });
  await waitFor(() => sent.length === 2, 'A session without account.id failed on the second message');
  assert.equal(nativeSends.length, 2);
  assert.equal(sent[1].item_list[0].text_item.text, '收到：接着聊');
  await desktop.close(); desktop = undefined;
  desktop = await electron.launch({ args: ['.'], env: { ...process.env, WECHAT_DOT_DATA: data } });
  const restarted = await desktop.firstWindow();
  await restarted.getByRole('button', { name: '暂停连接' }).waitFor({ timeout: extensionContext ? 90000 : 30000 });
  assert.equal(await setupVisible(), false, 'Restoring a connection should not open settings');
  await new Promise(r => setTimeout(r, 500));
  assert.equal(sent.length, 2);
  messages.push({ id: 'proactive', account_user_id: 'dot-member', content: { text: '主动问候' } });
  await waitFor(() => sent.length === 3, 'Proactive message did not deliver');
  assert.equal(sent[2].item_list[0].text_item.text, '主动问候');
  if (process.env.WECHAT_DOT_TEST_BROWSER === 'external') {
    browserPort = (await readFile(join(data, 'ChatGPT Browser', 'DevToolsActivePort'), 'utf8')).split('\n')[0];
    const exited = once(desktop.process(), 'exit');
    await desktop.evaluate(({ app }) => { setTimeout(() => app.exit(0), 0); });
    await exited;
    desktop = undefined;
    desktop = await electron.launch({ args: ['.'], env: { ...process.env, WECHAT_DOT_DATA: data } });
    await (await desktop.firstWindow()).getByRole('button', { name: '暂停连接' }).waitFor({ timeout: 45000 });
    messages.push({ id: 'after-crash', account_user_id: 'dot-member', content: { text: '意外退出后继续' } });
    await waitFor(() => sent.length === 4, 'A surviving browser could not be reconnected after a crash');
    assert.equal(sent[3].item_list[0].text_item.text, '意外退出后继续');
  }
  await reopenSetup();
  await (await desktop.firstWindow()).getByRole('button', { name: '暂停连接', exact: true }).click();
  await (await desktop.firstWindow()).getByRole('button', { name: '开始连接', exact: true }).waitFor();
  assert.equal(await setupVisible(), true, 'Pausing should keep the settings open');
  const settings = await desktop.firstWindow();
  breakSession = true;
  await settings.evaluate(() => window.wechatDot.action('discover'));
  assert.match((await settings.evaluate(() => window.wechatDot.status())).dotDetail, /Failed to fetch/, 'A page error should keep its cause instead of returning null');
  breakSession = false;
  for (const code of [403, 401]) {
    deniedStatus = code;
    await settings.evaluate(() => window.wechatDot.action('discover'));
    await waitFor(async () => (await settings.evaluate(() => window.wechatDot.status())).dot === 'error', 'Denied discovery should stop requesting login', 3000);
    const stoppedAt = dotRequests;
    await new Promise(r => setTimeout(r, 300));
    assert.equal(dotRequests, stoppedAt, 'Denied discovery must wait for an explicit action');
    assert.equal(await settings.getByRole('button', { name: '开始连接', exact: true }).isEnabled(), false);
    assert.equal(JSON.parse(await readFile(join(data, 'state.json'), 'utf8')).enabled, false);
  }
  deniedStatus = 0;
  await settings.evaluate(() => window.wechatDot.action('discover'));
  await settings.getByRole('button', { name: '开始连接', exact: true }).click();
  deniedStatus = 403;
  await waitFor(async () => !(await settings.evaluate(() => window.wechatDot.status())).running, 'Denied polling should pause the bridge');
  const stoppedAt = dotRequests;
  await new Promise(r => setTimeout(r, 300));
  assert.equal(dotRequests, stoppedAt, 'Paused access failure must not retry');
  assert.equal(JSON.parse(await readFile(join(data, 'state.json'), 'utf8')).enabled, false);
  assert.equal(await setupVisible(), true, 'An access failure should show its next action');
  deniedStatus = 0;
  await settings.evaluate(() => window.wechatDot.action('discover'));
  signedIn = false;
  const beforeLogout = dotRequests;
  await settings.evaluate(() => window.wechatDot.action('discover'));
  assert.equal((await settings.evaluate(() => window.wechatDot.status())).dot, 'error');
  assert.equal(dotRequests, beforeLogout, 'An empty login session must not reuse an old access token');
  console.log('PASS: denied login and polling pause requests until the user explicitly retries.');
  console.log('PASS: real Electron UI, tray lifecycle, QR fixture, draft attachments, native text reply, dedup, restart and proactive message.' + (process.env.WECHAT_DOT_TEST_BROWSER === 'external' ? ' External-browser crash recovery also passed.' : '') + ' These are local fixtures, not live accounts.');
} catch (e) {
  console.log('FIXTURE DRAFT', { draftAttachment, draftPolls, lastDraftPoll });
  console.log('FIXTURE REQUESTS', requests);
  if (browserPort) {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${browserPort}`, { noDefaults: true, timeout: 2000 }).catch(() => undefined);
    if (browser) {
      for (const page of browser.contexts()[0].pages()) {
        console.log('FIXTURE BROWSER', page.url(), await page.evaluate(() => ({ visibility: document.visibilityState, draft: Boolean(document.getElementById('attachment')), text: document.querySelector('textarea')?.value })).catch(() => 'unavailable'));
      }
      await browser.close();
    }
  }
  if (desktop) {
    for (const p of desktop.windows()) console.log('FIXTURE WINDOW', p.url());
    console.log('FIXTURE STATUS', await (await desktop.firstWindow()).evaluate(() => window.wechatDot.status()).catch(() => 'App exited'));
  }
  throw e;
} finally {
  if (desktop) await desktop.close().catch(() => {});
  if (extensionContext) await extensionContext.close();
  if (browserPort) {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${browserPort}`, { timeout: 2000 }).catch(() => undefined);
    if (browser) { const session = await browser.newBrowserCDPSession(); await session.send('Browser.close').catch(() => {}); await browser.close(); }
  }
  server.close();
  await rm(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
