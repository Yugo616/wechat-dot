import { _electron as electron, chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const data = await mkdtemp(join(tmpdir(), 'wechat-dot-desktop-'));
let draftAttachment = true;
let draftPolls = 0, lastDraftPoll;
let incoming = [], sent = [], nativeSends = [], messages = [{ id: 'old', account_user_id: 'dot-member', content: { text: '不应重发的历史' } }];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = []; for await (const b of req) parts.push(b);
  const body = Buffer.concat(parts).toString();
  res.setHeader('Content-Type', 'application/json');
  if (url.pathname === '/ilink/bot/get_bot_qrcode') return res.end(JSON.stringify({ qrcode: 'fixture-qr', qrcode_img_content: base }));
  if (url.pathname === '/ilink/bot/get_qrcode_status') return res.end(JSON.stringify({ status: 'confirmed', bot_token: 'fixture-weixin', ilink_bot_id: 'fixture-bot', ilink_user_id: 'fixture-owner', baseurl: base }));
  if (url.pathname === '/ilink/bot/getupdates') { const msgs = incoming.splice(0); return res.end(JSON.stringify({ ret: 0, msgs, get_updates_buf: 'cursor' })); }
  if (url.pathname === '/ilink/bot/sendmessage') { sent.push(JSON.parse(body).msg); return res.end('{"ret":0}'); }
  if (url.pathname === '/fixture/draft') { draftPolls++; lastDraftPoll = { at: new Date().toISOString(), attachment: draftAttachment }; return res.end(JSON.stringify({attachment:draftAttachment})); }
  if (url.pathname === '/api/auth/session') return res.end(JSON.stringify({ accessToken: 'fixture-chatgpt', user: { id: 'fixture-user' }, account: { id: 'fixture-account' } }));
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
await writeFile(join(data, 'config.json'), JSON.stringify({ weixin: { baseUrl: base, retryDelayMs: 30, longPollTimeoutMs: 500 }, dot: { browser: process.env.WECHAT_DOT_TEST_BROWSER ?? 'embedded', homeUrl: base + '/', pollIntervalMs: 50, sendTimeoutMs: 4000 } }));
let desktop, browserPort;
async function waitFor(test, label) { const end = Date.now() + 15000; while (!(await test())) { if (Date.now() > end) throw new Error(label); await new Promise(r => setTimeout(r, 50)); } }
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
  await page.getByRole('button', { name: '登录 ChatGPT', exact: true }).click();
  if (process.env.WECHAT_DOT_TEST_BROWSER === 'external') await page.getByRole('button', { name: '登录完成，识别 dot' }).click();
  await page.locator('#dot-badge[data-status="ready"]').waitFor({timeout:45000});
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
  draftAttachment = false;
  await waitFor(() => sent.length === 1, 'Native text loop did not deliver');
  assert.equal(sent[0].item_list[0].text_item.text, '收到：你好 dot');
  assert.equal(nativeSends.length, 1);
  incoming.push({ message_id: 'wx-1', from_user_id: 'fixture-owner', message_type: 1, message_state: 2, context_token: 'reply-context', item_list: [{ type: 1, text_item: { text: '你好 dot' } }] });
  await new Promise(r => setTimeout(r, 500));
  assert.equal(nativeSends.length, 1);
  await desktop.close(); desktop = undefined;
  desktop = await electron.launch({ args: ['.'], env: { ...process.env, WECHAT_DOT_DATA: data } });
  const restarted = await desktop.firstWindow();
  await restarted.getByRole('button', { name: '暂停连接' }).waitFor();
  assert.equal(await setupVisible(), false, 'Restoring a connection should not open settings');
  await new Promise(r => setTimeout(r, 500));
  assert.equal(sent.length, 1);
  messages.push({ id: 'proactive', account_user_id: 'dot-member', content: { text: '主动问候' } });
  await waitFor(() => sent.length === 2, 'Proactive message did not deliver');
  assert.equal(sent[1].item_list[0].text_item.text, '主动问候');
  if (process.env.WECHAT_DOT_TEST_BROWSER === 'external') {
    browserPort = (await readFile(join(data, 'ChatGPT Browser', 'DevToolsActivePort'), 'utf8')).split('\n')[0];
    const exited = once(desktop.process(), 'exit');
    await desktop.evaluate(({ app }) => { setTimeout(() => app.exit(0), 0); });
    await exited;
    desktop = undefined;
    desktop = await electron.launch({ args: ['.'], env: { ...process.env, WECHAT_DOT_DATA: data } });
    await (await desktop.firstWindow()).getByRole('button', { name: '暂停连接' }).waitFor({ timeout: 45000 });
    messages.push({ id: 'after-crash', account_user_id: 'dot-member', content: { text: '意外退出后继续' } });
    await waitFor(() => sent.length === 3, 'A surviving browser could not be reconnected after a crash');
    assert.equal(sent[2].item_list[0].text_item.text, '意外退出后继续');
  }
  await reopenSetup();
  await (await desktop.firstWindow()).getByRole('button', { name: '暂停连接', exact: true }).click();
  await (await desktop.firstWindow()).getByRole('button', { name: '开始连接', exact: true }).waitFor();
  assert.equal(await setupVisible(), true, 'Pausing should keep the settings open');
  console.log('PASS: real Electron UI, tray lifecycle, QR fixture, draft attachments, native text reply, dedup, restart and proactive message.' + (process.env.WECHAT_DOT_TEST_BROWSER === 'external' ? ' External-browser crash recovery also passed.' : '') + ' These are local fixtures, not live accounts.');
} catch (e) {
  console.log('FIXTURE DRAFT', { draftAttachment, draftPolls, lastDraftPoll });
  if (desktop) {
    for (const p of desktop.windows()) console.log('FIXTURE WINDOW', p.url());
    console.log('FIXTURE STATUS', await (await desktop.firstWindow()).evaluate(() => window.wechatDot.status()).catch(() => 'App exited'));
  }
  throw e;
} finally {
  if (desktop) await desktop.close().catch(() => {});
  if (browserPort) {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${browserPort}`, { timeout: 2000 }).catch(() => undefined);
    if (browser) { const session = await browser.newBrowserCDPSession(); await session.send('Browser.close').catch(() => {}); await browser.close(); }
  }
  server.close();
  await rm(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
