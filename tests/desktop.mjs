import { _electron as electron, chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { buildExtension } from '../scripts/extension.mjs';
import { createServer as createTcpServer } from 'node:net';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { encode } from 'silk-wasm';
const data = await mkdtemp(join(tmpdir(), 'wechat-dot-desktop-'));
let draftAttachment = true;
let draftPolls = 0, lastDraftPoll;
let deniedStatus = 0, dotRequests = 0;
let signedIn = true;
let breakSession = false;
const requests = [];
const mediaKey = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const picture = Buffer.from('89504e470d0a1a0aff0080abcd', 'hex');
const documentBytes = Buffer.from('文档测试内容\nhello document\n');
const mediaInputs = new Map([['picture', picture], ['document', documentBytes]]);
const uploadedFiles = new Map();
const cdnUploads = [], transcriptions = [];
let uploadTicket;
let failedMediaClientId;
let failedDotUpload = false;
let rejectWeixinSend = false, rejectedSends = 0;
let legacyDraft = false;
const legacyText = '旧版留下的消息\n\n下一段仍要保留。';
let mediaDownloads = new Set();
let incoming = [], sent = [], nativeSends = [], messages = [{ id: 'old', account_user_id: 'dot-member', content: { text: '不应重发的历史' } }];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/dots/thread') { res.writeHead(302, { Location: '/dots/home' }); return res.end(); }
  if (url.pathname !== '/fixture/draft' && !url.pathname.endsWith('getupdates')) { requests.push({ at: new Date().toISOString(), method: req.method, path: url.pathname }); if (requests.length > 30) requests.shift(); }
  const parts = []; for await (const b of req) parts.push(b);
  const bodyBytes = Buffer.concat(parts), body = bodyBytes.toString();
  res.setHeader('Content-Type', 'application/json');
  if (url.pathname.startsWith('/backend-api/')) {
    dotRequests++;
    if (deniedStatus) { res.statusCode = deniedStatus; return res.end('{"error":"access denied"}'); }
  }
  if (url.pathname === '/ilink/bot/get_bot_qrcode') return res.end(JSON.stringify({ qrcode: 'fixture-qr', qrcode_img_content: base }));
  if (url.pathname === '/ilink/bot/get_qrcode_status') return res.end(JSON.stringify({ status: 'confirmed', bot_token: 'fixture-weixin', ilink_bot_id: 'fixture-bot', ilink_user_id: 'fixture-owner', baseurl: base }));
  if (url.pathname === '/ilink/bot/getupdates') { const msgs = incoming.splice(0); return res.end(JSON.stringify({ ret: 0, msgs, get_updates_buf: 'cursor' })); }
  if (url.pathname === '/ilink/bot/sendmessage') {
    const message = JSON.parse(body).msg;
    if (rejectWeixinSend) { rejectedSends++; return res.end('{"ret":-2,"errmsg":"prepare failed"}'); }
    if (message.item_list[0].type === 4 && !failedMediaClientId) { failedMediaClientId = message.client_id; res.statusCode = 503; return res.end(); }
    sent.push(message); return res.end('{"ret":0}');
  }
  if (url.pathname === '/ilink/bot/getuploadurl') { uploadTicket = JSON.parse(body); return res.end(JSON.stringify({ upload_full_url: `${base}/fixture/cdn-upload` })); }
  if (url.pathname === '/fixture/cdn-upload') {
    const decipher = createDecipheriv('aes-128-ecb', Buffer.from(uploadTicket.aeskey, 'hex'), null);
    cdnUploads.push(Buffer.concat([decipher.update(bodyBytes), decipher.final()]));
    res.setHeader('x-encrypted-param', 'fixture-downloaded-' + cdnUploads.length); return res.end();
  }
  if (url.pathname.startsWith('/fixture/weixin-media/')) {
    const bytes = mediaInputs.get(url.pathname.split('/').at(-1));
    const cipher = createCipheriv('aes-128-ecb', mediaKey, null);
    return res.end(Buffer.concat([cipher.update(bytes), cipher.final()]));
  }
  if (url.pathname === '/backend-api/transcribe') {
    const form = await new Request(base, { method: 'POST', headers: req.headers, body: bodyBytes }).formData();
    const bytes = Buffer.from(await form.get('file').arrayBuffer());
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); transcriptions.push(bytes);
    return res.end(JSON.stringify({ text: '无转写语音测试' }));
  }
  if (url.pathname === '/backend-api/messaging/rooms/room/files' && req.method === 'POST') {
    const form = await new Request(base, { method: 'POST', headers: req.headers, body: bodyBytes }).formData();
    const file = form.get('file'), id = 'file-' + (uploadedFiles.size + 1);
    assert.equal(JSON.parse(await readFile(join(data, 'state.json'), 'utf8')).inbound.find(j => j.id === 'wx-media').phase, 'pending', 'Uploading files must not mark a message as submitted');
    if (uploadedFiles.size === 1 && !failedDotUpload) { failedDotUpload = true; res.statusCode = 503; return res.end('{}'); }
    const entry = { id, name: file.name, mime_type: file.type, bytes: Buffer.from(await file.arrayBuffer()) };
    uploadedFiles.set(id, entry);
    return res.end(JSON.stringify({ id, name: entry.name, mime_type: entry.mime_type, status: 'ready' }));
  }
  if (url.pathname.startsWith('/backend-api/messaging/rooms/room/files/')) {
    const file = uploadedFiles.get(url.pathname.split('/').at(-1));
    return res.end(JSON.stringify({ id: file.id, name: file.name, mime_type: file.mime_type, download_url: `${base}/fixture/dot-media/${file.id}` }));
  }
  if (url.pathname.startsWith('/fixture/dot-media/')) {
    if (mediaDownloads.has(url.pathname)) { res.statusCode = 410; return res.end(); }
    mediaDownloads.add(url.pathname);
    const file = uploadedFiles.get(url.pathname.split('/').at(-1));
    res.setHeader('Content-Type', file.mime_type); return res.end(file.bytes);
  }
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
      const attachments = (payload.content.attachments ?? []).map(a => { const f = uploadedFiles.get(a.file_id); return { type: 'file', file_id: f.id, file: { id: f.id, name: f.name, mime_type: f.mime_type } }; });
      messages.push({ id: `reply-${nativeSends.length}`, account_user_id: 'dot-member', content: { text: `收到：${payload.content.text}`, attachments } });
      return res.end(JSON.stringify({ id }));
    }
    const limit = Number(url.searchParams.get('limit') || 20);
    if (limit > 32) {
      res.statusCode = 422;
      return res.end(JSON.stringify({ detail: [{ loc: ['query', 'limit'], msg: 'Input should be less than or equal to 32', type: 'less_than_equal' }] }));
    }
    let items = messages;
    if (url.searchParams.has('after')) items = items.slice(items.findIndex(m => m.id === url.searchParams.get('after')) + 1);
    else items = items.slice(-limit);
    return res.end(JSON.stringify({ items, next_cursor: null }));
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><form><span id="attachment"><button type="button" aria-label="Remove file">private-draft.png</button></span><input type="file" multiple onchange="uploadFiles(this.files)"><div contenteditable="true" role="textbox" aria-label="訊息" style="min-height:32px">${legacyDraft ? '旧版留下的消息<div><br></div><div>下一段仍要保留。</div>' : ''}</div><button type="button" aria-label="傳送" disabled onclick="send()">傳送</button></form><script>
    let files=[];
    document.querySelector('[contenteditable]').addEventListener('input',()=>{const button=document.querySelector('[aria-label="傳送"]');button.disabled=true;setTimeout(()=>{button.disabled=false;},250);});
    async function uploadFiles(picked){document.querySelector('[aria-label="傳送"]').disabled=true;const previews=document.createElement('span');previews.id='upload-previews';document.querySelector('form').append(previews);for(const file of picked){const image=document.createElement('img');image.src=URL.createObjectURL(file);image.style.height='24px';previews.append(image);const remove=document.createElement('button');remove.type='button';remove.setAttribute('aria-label','Remove file');previews.append(remove);}try{for(const file of picked){const data=new FormData();data.append('file',file);const uploaded=await fetch('/backend-api/messaging/rooms/room/files',{method:'POST',body:data}).then(r=>{if(!r.ok)throw Error('Upload failed');return r.json();});files.push({type:'file',file_id:uploaded.id});}document.querySelector('[aria-label="傳送"]').disabled=false;}catch{}}
    setInterval(async()=>{const s=await fetch("/fixture/draft").then(r=>r.json());if(!s.attachment)document.getElementById("attachment")?.remove();},50);
    async function send(){const composer=document.querySelector('[contenteditable]');const text=composer.innerText;const request_id=crypto.randomUUID();await fetch('/backend-api/messaging/rooms/room/messages',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer fixture-chatgpt','ChatGPT-Account-Id':'fixture-account'},body:JSON.stringify({content:{text,attachments:files},request_id,idempotency_token:request_id})});composer.innerText='';files=[];document.querySelector('input[type=file]').value='';document.getElementById('upload-previews')?.remove();}
  </script>`);
}).listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const browserMode = process.env.WECHAT_DOT_TEST_BROWSER ?? 'embedded';
const externalBrowser = ['external', 'default'].includes(browserMode);
const dotConfig = { ...(browserMode === 'default' ? {} : { browser: browserMode }), homeUrl: base + '/', pollIntervalMs: 50, sendTimeoutMs: 4000 };
if (externalBrowser) dotConfig.browserExecutables = { [process.platform]: [process.env.WECHAT_DOT_TEST_CHROME || chromium.executablePath()] };
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
await writeFile(join(data, 'config.json'), JSON.stringify({ weixin: { baseUrl: base, cdnUrl: base, retryDelayMs: 30, longPollTimeoutMs: 500 }, dot: dotConfig }));
let desktop, browserPort;
const launchDesktop = () => electron.launch({ ...(process.env.WECHAT_DOT_EXECUTABLE ? { executablePath: process.env.WECHAT_DOT_EXECUTABLE, args: [] } : { args: ['.'] }), env: { ...process.env, WECHAT_DOT_DATA: data } });
async function waitFor(test, label, timeout = 15000) { const end = Date.now() + timeout; while (!(await test())) { if (Date.now() > end) throw new Error(label); await new Promise(r => setTimeout(r, 50)); } }
async function setupVisible() {
  return desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')).isVisible());
}
async function reopenSetup() {
  await desktop.evaluate(({ app }) => { app.emit('second-instance', {}, [], process.cwd()); });
  await waitFor(setupVisible, 'A second launch did not reopen connection settings');
}
try {
  desktop = await launchDesktop();
  const page = await desktop.firstWindow();
  if (browserMode === 'default') {
    assert.equal(await page.getByRole('button', { name: '安装 Chrome 扩展', exact: true }).isVisible(), false, 'The default installer must not ask the user to load an extension');
    assert.equal(await page.getByRole('button', { name: '登录 ChatGPT', exact: true }).isVisible(), true);
  }
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
  if (externalBrowser) await page.getByRole('button', { name: '登录完成，识别 dot' }).click();
  await page.locator('#dot-badge[data-status="ready"]').waitFor({timeout:45000});
  let managedPage, documentId;
  if (extensionContext) {
    managedPage = extensionContext.pages().find(p => p.url().startsWith(base));
    assert.equal(new URL(managedPage.url()).pathname, '/');
    documentId = await managedPage.evaluate(() => { history.pushState({}, '', '/dots/home'); return window.fixtureDocumentId = crypto.randomUUID(); });
  }
  if (externalBrowser) browserPort = (await readFile(join(data, 'ChatGPT Browser', 'DevToolsActivePort'), 'utf8')).split('\n')[0];
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
  await waitFor(async () => sent.length === 1 || (await page.evaluate(() => window.wechatDot.status())).needsReview, 'Native text loop did not deliver', 60000);
  assert.equal(sent.length, 1, 'The current dot composer must send its reply without a manual recovery step');
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
  desktop = await launchDesktop();
  const restarted = await desktop.firstWindow();
  await restarted.getByRole('button', { name: '暂停连接' }).waitFor({ timeout: extensionContext ? 90000 : 30000 });
  assert.equal(await setupVisible(), false, 'Restoring a connection should not open settings');
  await new Promise(r => setTimeout(r, 500));
  assert.equal(sent.length, 2);
  messages.push({ id: 'proactive', account_user_id: 'dot-member', content: { text: '主动问候' } });
  await waitFor(() => sent.length === 3, 'Proactive message did not deliver');
  assert.equal(sent[2].item_list[0].text_item.text, '主动问候');
  if (externalBrowser) {
    browserPort = (await readFile(join(data, 'ChatGPT Browser', 'DevToolsActivePort'), 'utf8')).split('\n')[0];
    const exited = once(desktop.process(), 'exit');
    await desktop.evaluate(({ app }) => { setTimeout(() => app.exit(0), 0); });
    await exited;
    desktop = undefined;
    desktop = await launchDesktop();
    await (await desktop.firstWindow()).getByRole('button', { name: '暂停连接' }).waitFor({ timeout: 45000 });
    messages.push({ id: 'after-crash', account_user_id: 'dot-member', content: { text: '意外退出后继续' } });
    await waitFor(() => sent.length === 4, 'A surviving browser could not be reconnected after a crash');
    assert.equal(sent[3].item_list[0].text_item.text, '意外退出后继续');
  }
  if (!extensionContext) {
    const start = sent.length;
    const media = name => ({ full_url: `${base}/fixture/weixin-media/${name}`, aes_key: Buffer.from(mediaKey.toString('hex')).toString('base64') });
    incoming.push({ message_id: 'wx-media', from_user_id: 'fixture-owner', message_type: 1, message_state: 2, context_token: 'reply-context', item_list: [
      { type: 1, text_item: { text: '图片和文档测试' } }, { type: 2, image_item: { media: media('picture') } }, { type: 4, file_item: { file_name: '测试.txt', media: media('document') } }
    ] });
    await waitFor(() => sent.length === start + 3, 'Image/document did not roundtrip', 15000);
    assert.equal(uploadedFiles.size, 3);
    assert.deepEqual([...uploadedFiles.values()].map(f => f.bytes), [picture, picture, documentBytes]);
    assert.deepEqual(cdnUploads, [picture, documentBytes]);
    assert.equal(sent[start + 1].item_list[0].type, 2);
    assert.equal(sent[start + 2].item_list[0].file_item.file_name, '测试.txt');
    assert.equal(sent[start + 2].client_id, failedMediaClientId, 'A failed attachment must retry the same message without replaying the text or image');
    const silk = await encode(Buffer.alloc(24000 / 5 * 2), 24000); mediaInputs.set('voice', Buffer.from(silk.data));
    incoming.push({ message_id: 'wx-voice', from_user_id: 'fixture-owner', message_type: 1, message_state: 2, context_token: 'reply-context', item_list: [{ type: 3, voice_item: { media: media('voice') } }] });
    await waitFor(() => sent.length === start + 4, 'Voice without WeChat transcript did not return', 15000);
    assert.equal(transcriptions.length, 1);
    assert.equal(sent.at(-1).item_list[0].text_item.text, '收到：无转写语音测试');
    incoming.push({ message_id: 'wx-transcribed', from_user_id: 'fixture-owner', message_type: 1, message_state: 2, context_token: 'reply-context', item_list: [{ type: 3, voice_item: { text: '微信已有转写' } }] });
    await waitFor(() => sent.length === start + 5, 'Supplied voice transcript did not return');
    assert.equal(transcriptions.length, 1, 'Use the supplied transcript without uploading voice again');
    console.log('PASS: image/document bytes and voice with/without a supplied transcript roundtrip through local fixtures.');
  }
  rejectWeixinSend = true;
  messages.push({ id: 'temporarily-rejected', account_user_id: 'dot-member', content: { text: '等微信恢复后补送' } });
  let recoverySettings = await desktop.firstWindow();
  await waitFor(async () => (await recoverySettings.evaluate(() => window.wechatDot.status())).weixinSendError, 'A rejected reply must show its recovery action');
  await reopenSetup();
  assert.match(await recoverySettings.locator('#detail').innerText(), /微信.*发一句话/);
  await recoverySettings.getByRole('button', { name: '暂停连接', exact: true }).click();
  assert.equal(await recoverySettings.getByRole('button', { name: '开始连接', exact: true }).isEnabled(), true, 'Pausing a send wait must not lock the receiver');
  await recoverySettings.getByRole('button', { name: '开始连接', exact: true }).click();
  await waitFor(async () => (await recoverySettings.evaluate(() => window.wechatDot.status())).running, 'Receiver did not restart while waiting to send');
  await desktop.close(); desktop = undefined;
  const saved = JSON.parse(await readFile(join(data, 'state.json'), 'utf8'));
  saved.inbound.push({ id: 'wx-legacy', phase: 'pending', composing: true, prepared: { text: legacyText, files: [] }, message: { message_id: 'wx-legacy', from_user_id: 'fixture-owner', context_token: 'reply-context', item_list: [{ type: 1, text_item: { text: legacyText } }] } });
  await writeFile(join(data, 'state.json'), JSON.stringify(saved));
  legacyDraft = true;
  desktop = await launchDesktop(); recoverySettings = await desktop.firstWindow();
  await recoverySettings.getByRole('button', { name: '暂停连接' }).waitFor({ timeout: extensionContext ? 90000 : 30000 });
  await waitFor(() => nativeSends.some(m => m.content.text === legacyText), 'An owned draft left by old multiline insertion must resume', 15000);
  legacyDraft = false;
  assert.ok((await recoverySettings.evaluate(() => window.wechatDot.status())).weixinSendError, 'Restart must keep the recovery notice');
  await new Promise(r => setTimeout(r, 300));
  assert.equal(rejectedSends, 1, 'Pause and restart must not repeatedly send a rejected reply');
  const beforeRecovery = sent.length;
  rejectWeixinSend = false;
  const recoveryText = '继续聊\n\n这是一条分段消息。';
  incoming.push({ message_id: 'wx-recovery', from_user_id: 'fixture-owner', message_type: 1, message_state: 2, context_token: 'reply-context', item_list: [{ type: 1, text_item: { text: recoveryText } }] });
  await waitFor(() => sent.length === beforeRecovery + 3, 'Fresh WeChat activity must deliver the saved replies and the next answer', 15000);
  assert.equal(sent[beforeRecovery].item_list[0].text_item.text, '等微信恢复后补送');
  assert.equal(sent[beforeRecovery + 1].item_list[0].text_item.text, '收到：' + legacyText);
  assert.equal(sent[beforeRecovery + 2].item_list[0].text_item.text, '收到：' + recoveryText);
  assert.equal((await recoverySettings.evaluate(() => window.wechatDot.status())).weixinSendError, undefined);
  console.log('PASS: rejected WeChat reply waits through pause/restart, then fresh activity resumes delivery and a multiline question.');
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
  await waitFor(async () => (await settings.evaluate(() => window.wechatDot.status())).running, 'Connection did not resume before the access test');
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
  await desktop.close(); desktop = undefined;
  const beforePausedRestart = dotRequests;
  desktop = await launchDesktop();
  const pausedRestart = await desktop.firstWindow();
  await pausedRestart.locator('#dot-button').waitFor();
  assert.equal((await pausedRestart.evaluate(() => window.wechatDot.status())).dot, 'idle', 'Restarting a paused connection must wait for an explicit login action');
  await new Promise(r => setTimeout(r, 300));
  assert.equal(dotRequests, beforePausedRestart, 'A paused restart must not make automatic ChatGPT requests');
  console.log('PASS: denied login and polling pause requests until the user explicitly retries.');
  console.log('PASS: real Electron UI, tray lifecycle, QR fixture, draft attachments, native text reply, dedup, restart and proactive message.' + (externalBrowser ? ' External-browser crash recovery also passed.' : '') + ' These are local fixtures, not live accounts.');
} catch (e) {
  console.log('FIXTURE DRAFT', { draftAttachment, draftPolls, lastDraftPoll });
  console.log('FIXTURE REQUESTS', requests);
  if (externalBrowser && !browserPort) browserPort = await readFile(join(data, 'ChatGPT Browser', 'DevToolsActivePort'), 'utf8').then(value => value.split('\n')[0]).catch(() => undefined);
  if (browserPort) {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${browserPort}`, { noDefaults: true, timeout: 2000 }).catch(() => undefined);
    if (browser) {
      for (const page of browser.contexts()[0].pages()) {
        console.log('FIXTURE BROWSER', page.url(), await page.evaluate(() => ({ visibility: document.visibilityState, draft: Boolean(document.getElementById('attachment')), text: document.querySelector('[contenteditable]')?.innerText, charset: document.characterSet, buttons: [...document.querySelectorAll('button')].map(b => b.getAttribute('aria-label')) })).catch(() => 'unavailable'));
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
