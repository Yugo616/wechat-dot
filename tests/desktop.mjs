import { _electron as electron } from 'playwright-core';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const data = await mkdtemp(join(tmpdir(), 'wechat-dot-desktop-'));
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
  res.end(`<!doctype html><textarea id="prompt-textarea"></textarea><button data-testid="send-button" onclick="send()">Send</button><script>
    async function send(){const text=document.querySelector('textarea').value;const request_id=crypto.randomUUID();await fetch('/backend-api/messaging/rooms/room/messages',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer fixture-chatgpt','ChatGPT-Account-Id':'fixture-account'},body:JSON.stringify({content:{text},request_id,idempotency_token:request_id})});document.querySelector('textarea').value='';}
  </script>`);
}).listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
await writeFile(join(data, 'config.json'), JSON.stringify({ weixin: { baseUrl: base, retryDelayMs: 30, longPollTimeoutMs: 500 }, dot: { browser: process.env.WECHAT_DOT_TEST_BROWSER ?? 'embedded', homeUrl: base + '/', pollIntervalMs: 50, sendTimeoutMs: 4000 } }));
let desktop;
async function waitFor(test, label) { const end = Date.now() + 15000; while (!test()) { if (Date.now() > end) throw new Error(label); await new Promise(r => setTimeout(r, 50)); } }
try {
  desktop = await electron.launch({ args: ['.'], env: { ...process.env, WECHAT_DOT_DATA: data } });
  const page = await desktop.firstWindow();
  await page.getByRole('button', { name: '微信扫码', exact: true }).click();
  await page.locator('#weixin-badge[data-status="ready"]').waitFor();
  await page.getByRole('button', { name: '登录 ChatGPT', exact: true }).click();
  if (process.env.WECHAT_DOT_TEST_BROWSER === 'external') await page.getByRole('button', { name: '登录完成，识别 dot' }).click();
  await page.locator('#dot-badge[data-status="ready"]').waitFor({timeout:45000});
  await page.getByRole('button', { name: /开始连接/ }).click();
  await page.getByRole('button', { name: '暂停连接' }).waitFor();
  incoming.push({ message_id: 'wx-1', from_user_id: 'fixture-owner', message_type: 1, message_state: 2, context_token: 'reply-context', item_list: [{ type: 1, text_item: { text: '你好 dot' } }] });
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
  await new Promise(r => setTimeout(r, 500));
  assert.equal(sent.length, 1);
  messages.push({ id: 'proactive', account_user_id: 'dot-member', content: { text: '主动问候' } });
  await waitFor(() => sent.length === 2, 'Proactive message did not deliver');
  assert.equal(sent[1].item_list[0].text_item.text, '主动问候');
  console.log('PASS: real Electron UI, QR fixture, native composer, text reply, dedup, restart, proactive message. These are local protocol fixtures, not live accounts.');
} catch (e) { if (desktop) { for (const p of desktop.windows()) console.log('FIXTURE WINDOW', p.url()); console.log('ELECTRON WINDOWS', await desktop.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().map(w=>({id:w.id, url:w.webContents.getURL(),loading:w.webContents.isLoading(),title:w.title})))); console.log('FIXTURE STATUS', await (await desktop.firstWindow()).evaluate(() => window.wechatDot.status())); } throw e; } finally { if (desktop) await desktop.close(); server.close(); await rm(data, { recursive: true, force: true }); }
