import { _electron as electron, chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, readlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { buildExtension } from '../scripts/extension.mjs';
import { createServer as createTcpServer } from 'node:net';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { encode } from 'silk-wasm';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const data = await mkdtemp(join(tmpdir(), 'wechat-dot-desktop-'));
let draftAttachment = true;
let draftPolls = 0, lastDraftPoll;
let deniedStatus = 0, dotRequests = 0;
let signedIn = true;
let breakSession = false;
let sessionRequests = 0;
let sessionGate;
let weixinSendGate, sendRequests = 0;
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
let weixinExpired = false, qrFailures = 1, qrExpired = 1, qrRequests = 0;
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
  if (url.pathname === '/ilink/bot/get_bot_qrcode') {
    qrRequests++;
    if (qrFailures > 0) { qrFailures--; res.statusCode = 503; return res.end(); }
    return res.end(JSON.stringify({ qrcode: 'fixture-qr', qrcode_img_content: base }));
  }
  if (url.pathname === '/ilink/bot/get_qrcode_status') {
    if (qrExpired > 0) { qrExpired--; return res.end(JSON.stringify({ status: 'expired' })); }
    return res.end(JSON.stringify({ status: 'confirmed', bot_token: 'fixture-weixin', ilink_bot_id: 'fixture-bot', ilink_user_id: 'fixture-owner', baseurl: base }));
  }
  if (url.pathname === '/ilink/bot/getupdates') {
    if (weixinExpired) return res.end('{"ret":-14}');
    const msgs = incoming.splice(0); return res.end(JSON.stringify({ ret: 0, msgs, get_updates_buf: 'cursor' }));
  }
  if (url.pathname === '/ilink/bot/sendmessage') {
    sendRequests++; await weixinSendGate;
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
  if (url.pathname === '/fixture/draft') { draftPolls++; lastDraftPoll = { at: new Date().toISOString(), attachment: draftAttachment, document: url.searchParams.get('document'), title: url.searchParams.get('title') }; return res.end(JSON.stringify({attachment:draftAttachment})); }
  if (url.pathname === '/api/auth/session') {
    sessionRequests++;
    await sessionGate;
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
    let files=[]; const loginDocument=crypto.randomUUID();
    document.querySelector('[contenteditable]').addEventListener('input',()=>{const button=document.querySelector('[aria-label="傳送"]');button.disabled=true;setTimeout(()=>{button.disabled=false;},250);});
    async function uploadFiles(picked){document.querySelector('[aria-label="傳送"]').disabled=true;const previews=document.createElement('span');previews.id='upload-previews';document.querySelector('form').append(previews);for(const file of picked){const image=document.createElement('img');image.src=URL.createObjectURL(file);image.style.height='24px';previews.append(image);const remove=document.createElement('button');remove.type='button';remove.setAttribute('aria-label','Remove file');previews.append(remove);}try{for(const file of picked){const data=new FormData();data.append('file',file);const uploaded=await fetch('/backend-api/messaging/rooms/room/files',{method:'POST',body:data}).then(r=>{if(!r.ok)throw Error('Upload failed');return r.json();});files.push({type:'file',file_id:uploaded.id});}document.querySelector('[aria-label="傳送"]').disabled=false;}catch{}}
    setInterval(async()=>{const s=await fetch("/fixture/draft?"+new URLSearchParams({document:loginDocument,title:document.title})).then(r=>r.json());if(!s.attachment)document.getElementById("attachment")?.remove();},50);
    async function send(){const composer=document.querySelector('[contenteditable]');const text=composer.innerText;const request_id=crypto.randomUUID();await fetch('/backend-api/messaging/rooms/room/messages',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer fixture-chatgpt','ChatGPT-Account-Id':'fixture-account'},body:JSON.stringify({content:{text,attachments:files},request_id,idempotency_token:request_id})});composer.innerText='';files=[];document.querySelector('input[type=file]').value='';document.getElementById('upload-previews')?.remove();}
  </script>`);
}).listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const defaults = JSON.parse(await readFile('config/defaults.json', 'utf8'));
const browserProfile = defaults.dot.runtime.profileDirectory;
const browserMode = process.env.WECHAT_DOT_TEST_BROWSER ?? 'embedded';
const externalBrowser = ['external', 'default'].includes(browserMode);
const dotConfig = { ...(browserMode === 'default' ? {} : { browser: browserMode }), homeUrl: base + '/', pollIntervalMs: 50, sendTimeoutMs: 4000 };
let extensionContext;
if (externalBrowser || dotConfig.browser === 'extension') {
  const portProbe = createTcpServer().listen(0, '127.0.0.1'); await once(portProbe, 'listening');
  const port = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve));
  dotConfig.extension = { ...defaults.dot.extension, port };
}
if (dotConfig.browser === 'extension') {
  const directory = join(data, 'extension'); await buildExtension(directory, dotConfig);
  extensionContext = await chromium.launchPersistentContext(join(data, 'browser'), { channel: 'chromium', executablePath: process.env.WECHAT_DOT_TEST_CHROME, headless: true,
    args: [`--disable-extensions-except=${directory}`, `--load-extension=${directory}`] });
}
await writeFile(join(data, 'config.json'), JSON.stringify({ weixin: { baseUrl: base, cdnUrl: base, retryDelayMs: 30, longPollTimeoutMs: 500 }, dot: dotConfig }));
let desktop, browserPort;
const launchDesktop = () => electron.launch({ ...(process.env.WECHAT_DOT_EXECUTABLE ? { executablePath: process.env.WECHAT_DOT_EXECUTABLE, args: [] } : { args: ['.'] }), env: { ...process.env, WECHAT_DOT_DATA: data } });
async function browserProcesses() {
  if (process.platform !== 'win32') return [];
  const script = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('--user-data-dir=' + $env:WECHAT_DOT_FIXTURE_PROFILE) -and !$_.CommandLine.Contains('--type=') } | ForEach-Object { $p = Get-Process -Id $_.ProcessId; [pscustomobject]@{ pid = $_.ProcessId; parent = $_.ParentProcessId; window = $p.MainWindowHandle.ToInt64() } } | ConvertTo-Json -Compress`;
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, WECHAT_DOT_FIXTURE_PROFILE: join(data, browserProfile) } });
  return stdout.trim() ? [JSON.parse(stdout)].flat() : [];
}
async function waitFor(test, label, timeout = 15000) { const end = Date.now() + timeout; while (!(await test())) { if (Date.now() > end) throw new Error(label); await new Promise(r => setTimeout(r, 50)); } }
async function setupVisible() {
  return desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')).isVisible());
}
async function reopenSetup() {
  await desktop.evaluate(({ app }) => { app.emit('second-instance', {}, [], process.cwd()); });
  await waitFor(setupVisible, 'A second launch did not reopen connection settings');
}
async function closeManagedBrowser(targetOnly = false) {
  if (externalBrowser) {
    const profile = join(data, browserProfile);
    if (process.platform === 'win32') {
      const script = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('--user-data-dir=' + $env:WECHAT_DOT_FIXTURE_PROFILE) -and !$_.CommandLine.Contains('--type=') } | ForEach-Object { & taskkill /PID $_.ProcessId /T /F | Out-Null }`;
      await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, WECHAT_DOT_FIXTURE_PROFILE: profile } });
    } else {
      const lock = await readlink(join(profile, 'SingletonLock'));
      const pid = Number(lock.slice(lock.lastIndexOf('-') + 1));
      const { stdout } = await promisify(execFile)('ps', ['-p', String(pid), '-o', 'args=']);
      assert.ok(stdout.includes(`--user-data-dir=${profile}`));
      process.kill(pid, 'SIGTERM');
    }
  } else {
    await desktop.evaluate(({ BrowserWindow }, origin) => {
      BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith(origin)).destroy();
    }, base);
  }
}
try {
  desktop = await launchDesktop();
  if (externalBrowser) await desktop.evaluate(async () => {
    const cp = process.getBuiltinModule('child_process');
    const original = cp.spawn;
    globalThis.fixtureBrowserEvents = [];
    cp.spawn = function (command, args, options) {
      if (!command.includes('Browser Runtime')) return original.call(this, command, args, options);
      const child = original.call(this, command, [...args, '--enable-logging=stderr'], { ...options, stdio: ['ignore', 'ignore', 'pipe'] });
      const events = globalThis.fixtureBrowserEvents;
      events.push({ event: 'spawn', pid: child.pid, args });
      child.on('error', error => events.push({ event: 'error', message: error.message }));
      child.on('exit', (code, signal) => events.push({ event: 'exit', code, signal }));
      child.stderr.on('data', bytes => { events.push({ event: 'stderr', text: bytes.toString().slice(-3000) }); if (events.length > 40) events.splice(1, 1); });
      return child;
    };
    process.getBuiltinModule('module').syncBuiltinESMExports();
  });
  const page = await desktop.firstWindow();
  await page.getByRole('heading', { name: 'WeChat Dot', exact: true }).waitFor();
  await page.evaluate(() => {
    window.fixtureStatusChanges = [];
    window.wechatDot.onStatus(s => {
      const next = JSON.stringify({ dot: s.dot, dotDetail: s.dotDetail, problem: s.problem });
      if (next !== window.fixtureStatusChanges.at(-1)) window.fixtureStatusChanges.push(next);
      if (window.fixtureStatusChanges.length > 20) window.fixtureStatusChanges.shift();
    });
  });
  if (browserMode === 'default') {
    assert.equal(await page.getByRole('button', { name: '安装 Chrome 扩展', exact: true }).isVisible(), false, 'The default installer must not ask the user to load an extension');
    assert.equal(await page.getByRole('button', { name: '登录 ChatGPT', exact: true }).isVisible(), true);
  }
  await page.getByRole('button', { name: '微信扫码', exact: true }).click();
  await page.locator('#weixin-badge[data-status="ready"]').waitFor({ timeout: 5000 });
  assert.equal(qrRequests, 3, 'QR network failure and expiry must recover without another click');
  if (externalBrowser) {
    await desktop.evaluate(({ net }) => {
      const original = net.fetch.bind(net);
      globalThis.fixtureRuntimeRequested = false;
      globalThis.fixtureRuntimeAborted = false;
      net.fetch = (url, options) => {
        if (!String(url).includes('chrome-for-testing-public')) return original(url, options);
        globalThis.fixtureRuntimeRequested = true;
        return new Promise((_, reject) => options.signal.addEventListener('abort', () => {
          globalThis.fixtureRuntimeAborted = true; reject(options.signal.reason);
        }, { once: true }));
      };
      globalThis.fixtureRestoreDownload = () => { net.fetch = original; };
    });
    await page.evaluate(() => { void window.wechatDot.action('start'); });
    await waitFor(() => desktop.evaluate(() => globalThis.fixtureRuntimeRequested), 'Cold startup did not request its own browser');
    await page.getByRole('button', { name: '暂停转发', exact: true }).click();
    await waitFor(() => desktop.evaluate(() => globalThis.fixtureRuntimeAborted), 'Pausing must cancel browser preparation during discovery');
    assert.equal(await desktop.evaluate(() => globalThis.fixtureBrowserEvents.some(e => e.event === 'spawn')), false, 'Pause must not launch a late browser');
    await desktop.evaluate(() => { globalThis.fixtureRestoreDownload(); });
  }
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
  let loginDocument;
  if (externalBrowser) {
    await waitFor(() => draftPolls > 0, 'The managed browser must download and open the login page', defaults.dot.runtime.downloadTimeoutMs + 60000);
    if (process.platform === 'win32') await waitFor(async () => (await browserProcesses()).some(browser => browser.window !== 0), 'The login browser must have a visible Windows window');
    loginDocument = lastDraftPoll.document;
    await page.getByRole('button', { name: '登录完成，识别 dot' }).click();
  }
  await page.locator('#dot-badge[data-status="ready"]').waitFor({timeout:45000});
  let managedPage, documentId;
  if (extensionContext) {
    managedPage = extensionContext.pages().find(p => p.url().startsWith(base));
    assert.equal(new URL(managedPage.url()).pathname, '/');
    documentId = await managedPage.evaluate(() => { history.pushState({}, '', '/dots/home'); return window.fixtureDocumentId = crypto.randomUUID(); });
  }
  if (externalBrowser) {
    await waitFor(() => lastDraftPoll.title === 'WeChat Dot 专用 · ChatGPT', 'The dedicated browser must stay visibly identified');
    assert.equal(lastDraftPoll.document, loginDocument, 'Finishing login must preserve the authenticated document');
    await assert.rejects(readFile(join(data, browserProfile, 'DevToolsActivePort')), { code: 'ENOENT' });
  }
  if (!extensionContext) {
    await closeManagedBrowser();
    await new Promise(r => setTimeout(r, 300));
    assert.equal((await page.evaluate(() => window.wechatDot.status())).running, false);
  }
  const beforeStartCheck = sessionRequests;
  await page.getByRole('button', { name: /开始转发/ }).click();
  await page.getByRole('button', { name: '暂停转发' }).waitFor();
  await waitFor(() => sessionRequests > beforeStartCheck, 'Start must check the saved login before forwarding', 30000);
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
  if (!extensionContext) {
    const beforeRecoveryCheck = sessionRequests;
    await closeManagedBrowser(externalBrowser);
    await waitFor(async () => sessionRequests > beforeRecoveryCheck && (await page.evaluate(() => window.wechatDot.status())).running, 'A closed browser must recover its login and resume forwarding', 30000);
    await new Promise(r => setTimeout(r, 300));
    assert.equal(sent.length, 1, 'Browser recovery must not resend replies');
    assert.equal(nativeSends.length, 1, 'Browser recovery must not repeat questions');
  }
  incoming.push({ message_id: 'wx-2', from_user_id: 'fixture-owner', message_type: 1, message_state: 2, context_token: 'reply-context', item_list: [{ type: 1, text_item: { text: '接着聊' } }] });
  await waitFor(() => sent.length === 2, 'A session without account.id failed on the second message after browser recovery');
  assert.equal(nativeSends.length, 2);
  assert.equal(sent[1].item_list[0].text_item.text, '收到：接着聊');
  await desktop.close(); desktop = undefined;
  desktop = await launchDesktop();
  const restarted = await desktop.firstWindow();
  await restarted.getByRole('button', { name: '暂停转发' }).waitFor({ timeout: extensionContext ? 90000 : 30000 });
  assert.equal(await setupVisible(), false, 'Restoring a connection should not open settings');
  await new Promise(r => setTimeout(r, 500));
  assert.equal(sent.length, 2);
  messages.push({ id: 'proactive', account_user_id: 'dot-member', content: { text: '主动问候' } });
  await waitFor(() => sent.length === 3, 'Proactive message did not deliver');
  assert.equal(sent[2].item_list[0].text_item.text, '主动问候');
  if (externalBrowser) {
    await waitFor(async () => JSON.parse(await readFile(join(data, 'state.json'), 'utf8')).outbound.find(job => job.id === 'proactive')?.phase === 'done', 'Proactive delivery was not saved before the crash test');
    const beforeCrashDocument = lastDraftPoll.document;
    console.log('FIXTURE BEFORE APP CRASH', { document: beforeCrashDocument, processes: await browserProcesses() });
    const exited = once(desktop.process(), 'exit');
    await desktop.evaluate(({ app }) => { setTimeout(() => app.exit(0), 0); });
    await exited;
    console.log('FIXTURE SURVIVING BROWSER', await browserProcesses());
    desktop = undefined;
    desktop = await launchDesktop();
    await (await desktop.firstWindow()).getByRole('button', { name: '暂停转发' }).waitFor({ timeout: 45000 });
    messages.push({ id: 'after-crash', account_user_id: 'dot-member', content: { text: '意外退出后继续' } });
    await waitFor(() => sent.length === 4, 'A surviving browser could not be reconnected after a crash');
    assert.equal(sent[3].item_list[0].text_item.text, '意外退出后继续');
    console.log('FIXTURE AFTER APP CRASH', { document: lastDraftPoll.document, processes: await browserProcesses() });
    assert.equal(lastDraftPoll.document, beforeCrashDocument, 'App recovery must reuse the surviving authenticated document');
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
  assert.match(await recoverySettings.locator('#detail').innerText(), /手机微信/);
  assert.equal(await recoverySettings.locator('#recovery-button').isVisible(), false, 'WeChat must not require a desktop installation');
  await recoverySettings.getByRole('button', { name: '暂停转发', exact: true }).click();
  assert.equal(await recoverySettings.getByRole('button', { name: '开始转发', exact: true }).isEnabled(), true, 'Pausing a send wait must not lock the receiver');
  await recoverySettings.getByRole('button', { name: '开始转发', exact: true }).click();
  await waitFor(async () => (await recoverySettings.evaluate(() => window.wechatDot.status())).running, 'Receiver did not restart while waiting to send');
  await desktop.close(); desktop = undefined;
  const saved = JSON.parse(await readFile(join(data, 'state.json'), 'utf8'));
  saved.inbound.push({ id: 'wx-legacy', phase: 'pending', composing: true, prepared: { text: legacyText, files: [] }, message: { message_id: 'wx-legacy', from_user_id: 'fixture-owner', context_token: 'reply-context', item_list: [{ type: 1, text_item: { text: legacyText } }] } });
  await writeFile(join(data, 'state.json'), JSON.stringify(saved));
  legacyDraft = true;
  desktop = await launchDesktop(); recoverySettings = await desktop.firstWindow();
  await recoverySettings.getByRole('button', { name: '暂停转发' }).waitFor({ timeout: extensionContext ? 90000 : 30000 });
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
  await desktop.close(); desktop = undefined;
  const backlog = JSON.parse(await readFile(join(data, 'state.json'), 'utf8'));
  const backlogWindow = JSON.parse(await readFile('config/defaults.json', 'utf8')).storage.maxBacklogAgeMs;
  const expiredAt = Date.now() - backlogWindow - 1000, recentAt = Date.now();
  const expiredQuestion = { id: 'wx-expired', phase: 'pending', composing: true, prepared: { text: legacyText, files: [] }, message: { create_time_ms: expiredAt, item_list: [{ text_item: { text: legacyText } }] } };
  backlog.inbound.push(expiredQuestion, { id: 'wx-recent', phase: 'pending', message: { create_time_ms: recentAt, item_list: [{ text_item: { text: '只处理最近的问题' } }] } });
  backlog.outbound.push({ id: 'expired-reply', phase: 'pending', part: 1, message: { id: 'expired-reply', text: '已经发出的旧文字', createdAt: new Date(expiredAt).toISOString(), complete: true, attachments: [{ id: 'never-download', name: '旧附件.txt', mime: 'text/plain' }] } });
  const beforeBacklog = { sent: sent.length, native: nativeSends.length, dot: backlog.dot };
  messages.push({ id: 'expired-generation', created_at: new Date(expiredAt).toISOString(), account_user_id: 'dot-member', content: { text: '旧的未完成回复' }, generation: { status: 'in_progress' } });
  await writeFile(join(data, 'state.json'), JSON.stringify(backlog));
  legacyDraft = true;
  desktop = await launchDesktop(); recoverySettings = await desktop.firstWindow();
  await waitFor(() => sent.length === beforeBacklog.sent + 1, 'An expired owned draft must clear automatically so the recent question can receive its answer', 30000);
  legacyDraft = false;
  assert.equal(nativeSends.length, beforeBacklog.native + 1);
  assert.equal(nativeSends.at(-1).content.text, '只处理最近的问题');
  await reopenSetup();
  await waitFor(async () => (await recoverySettings.locator('#backlog-note').textContent()) === '3 条消息已暂存', 'Held count must appear once in the settings');
  const afterBacklog = JSON.parse(await readFile(join(data, 'state.json'), 'utf8'));
  assert.deepEqual(afterBacklog.dot, beforeBacklog.dot, 'Expiring work must retain the original dot conversation');
  assert.equal(afterBacklog.inbound.find(j => j.id === 'wx-expired').composing, undefined);
  assert.equal(afterBacklog.outbound.find(j => j.id === 'expired-reply').part, 1, 'Do not send the remaining expired attachment');
  console.log('PASS: restart skips expired questions, remaining attachments and unfinished generations; clears only the owned draft and forwards the recent question.');
  await reopenSetup();
  await (await desktop.firstWindow()).getByRole('button', { name: '暂停转发', exact: true }).click();
  await (await desktop.firstWindow()).getByRole('button', { name: '开始转发', exact: true }).waitFor();
  assert.equal(await setupVisible(), true, 'Pausing should keep the settings open');
  const settings = await desktop.firstWindow();
  let releaseSession;
  sessionGate = new Promise(resolve => { releaseSession = resolve; });
  const beforeCancelledCheck = sessionRequests;
  const checking = settings.evaluate(() => window.wechatDot.action('start'));
  await waitFor(() => sessionRequests > beforeCancelledCheck, 'Start should check login before any send');
  assert.equal(await settings.getByRole('button', { name: '暂停转发', exact: true }).isEnabled(), true, 'An in-progress start can be paused');
  await settings.getByRole('button', { name: '暂停转发', exact: true }).click();
  releaseSession(); sessionGate = undefined;
  await checking;
  assert.equal((await settings.evaluate(() => window.wechatDot.status())).running, false, 'A late login check must not undo pause');
  assert.equal(JSON.parse(await readFile(join(data, 'state.json'), 'utf8')).enabled, false);
  const checksAfterPause = sessionRequests;
  await new Promise(r => setTimeout(r, 300));
  assert.equal(sessionRequests, checksAfterPause, 'Pause should stop automatic login checks');
  breakSession = true;
  await settings.evaluate(() => window.wechatDot.action('discover'));
  assert.equal(await settings.locator('#running').textContent(), '正在自动重试');
  assert.match(await settings.locator('#detail').textContent(), /无需操作/);
  assert.doesNotMatch(await settings.locator('body').textContent(), /Failed to fetch/);
  const beforeAutomaticRecovery = sessionRequests;
  breakSession = false;
  await waitFor(async () => (await settings.evaluate(() => window.wechatDot.status())).dot === 'ready', 'Login discovery must recover without another click');
  assert.ok(sessionRequests > beforeAutomaticRecovery);
  assert.equal((await settings.evaluate(() => window.wechatDot.status())).dotRetry, undefined);
  assert.equal(await settings.locator('#running').textContent(), '转发已暂停', 'A discovery retry must respect the existing paused state');
  for (const code of [403, 401]) {
    deniedStatus = code;
    await settings.evaluate(() => window.wechatDot.action('discover'));
    await waitFor(async () => (await settings.evaluate(() => window.wechatDot.status())).dot === 'error', 'Denied discovery should stop requesting login', 3000);
    const stoppedAt = dotRequests;
    await new Promise(r => setTimeout(r, 300));
    assert.equal(dotRequests, stoppedAt, 'Denied discovery must wait for an explicit action');
    assert.equal(await settings.locator('#toggle').isVisible(), false, 'An expired login should present its recovery button without an unusable Start button');
    assert.equal(JSON.parse(await readFile(join(data, 'state.json'), 'utf8')).enabled, false);
    assert.equal(await settings.locator('#recovery-button').textContent(), '重连 dot');
    assert.equal(await settings.locator('#recovery-button').isEnabled(), true);
  }
  deniedStatus = 0;
  await settings.evaluate(() => window.wechatDot.action('discover'));
  await settings.getByRole('button', { name: '开始转发', exact: true }).click();
  await waitFor(async () => (await settings.evaluate(() => window.wechatDot.status())).running, 'Connection did not resume before the access test');
  deniedStatus = 403;
  await waitFor(async () => !(await settings.evaluate(() => window.wechatDot.status())).running, 'Denied polling should pause the bridge');
  const stoppedAt = dotRequests;
  await new Promise(r => setTimeout(r, 300));
  assert.equal(dotRequests, stoppedAt, 'Paused access failure must not retry');
  assert.equal(JSON.parse(await readFile(join(data, 'state.json'), 'utf8')).enabled, false);
  assert.equal(await setupVisible(), true, 'An access failure should show its next action');
  deniedStatus = 0;
  const beforeReloginPage = draftPolls;
  await settings.locator('#recovery-button').click();
  if (externalBrowser) {
    await waitFor(() => draftPolls > beforeReloginPage, 'The reconnect login window did not load', 45000);
    await settings.getByRole('button', { name: '登录完成，识别 dot' }).click();
  }
  await waitFor(async () => (await settings.evaluate(() => window.wechatDot.status())).running, 'Completing dot reconnection must resume forwarding without Start', 45000);
  await settings.evaluate(() => window.wechatDot.action('pause'));
  signedIn = false;
  const beforeLogout = dotRequests;
  const beforeExpiredStart = nativeSends.length;
  await settings.evaluate(() => window.wechatDot.action('start'));
  assert.equal((await settings.evaluate(() => window.wechatDot.status())).dot, 'error');
  assert.equal((await settings.evaluate(() => window.wechatDot.status())).running, false);
  assert.equal(nativeSends.length, beforeExpiredStart, 'An expired login must be caught before forwarding');
  assert.equal(dotRequests, beforeLogout, 'An empty login session must not reuse an old access token');
  await desktop.close(); desktop = undefined;
  const beforePausedRestart = dotRequests;
  desktop = await launchDesktop();
  const pausedRestart = await desktop.firstWindow();
  await pausedRestart.locator('#dot-button').waitFor();
  assert.equal((await pausedRestart.evaluate(() => window.wechatDot.status())).dot, 'ready', 'A paused restart should retain the saved binding without checking login');
  assert.equal(await pausedRestart.getByRole('button', { name: '开始转发', exact: true }).isEnabled(), true);
  assert.equal(await pausedRestart.locator('#dot-badge').textContent(), '已绑定');
  assert.equal(await pausedRestart.locator('#running').textContent(), '转发已暂停');
  await new Promise(r => setTimeout(r, 300));
  assert.equal(dotRequests, beforePausedRestart, 'A paused restart must not make automatic ChatGPT requests');
  signedIn = true;
  const beforeSavedStart = sessionRequests;
  await pausedRestart.getByRole('button', { name: '开始转发', exact: true }).click();
  await waitFor(async () => (await pausedRestart.evaluate(() => window.wechatDot.status())).running, 'A saved binding must start without asking for login again', 30000);
  assert.ok(sessionRequests > beforeSavedStart, 'A saved binding needs a fresh login check');
  weixinExpired = true;
  await waitFor(async () => (await pausedRestart.evaluate(() => window.wechatDot.status())).weixin === 'error', 'WeChat expiry did not stop forwarding');
  assert.equal(await setupVisible(), true, 'WeChat expiry should show its reconnect button');
  assert.equal(await pausedRestart.locator('#recovery-button').textContent(), '重连微信');
  assert.equal(JSON.parse(await readFile(join(data, 'state.json'), 'utf8')).enabled, false);
  weixinExpired = false;
  await pausedRestart.locator('#recovery-button').click();
  await waitFor(async () => (await pausedRestart.evaluate(() => window.wechatDot.status())).running, 'Completing WeChat reconnection must resume forwarding without Start', 45000);
  assert.equal(JSON.parse(await readFile(join(data, 'state.json'), 'utf8')).enabled, true);
  console.log('PASS: QR failures/expiry recover automatically; inline reconnect buttons resume both accounts after login.');
  for (const account of ['weixin', 'dot']) for (const cancel of [false, true]) {
    await pausedRestart.evaluate(() => window.wechatDot.action('start'));
    await waitFor(async () => (await pausedRestart.evaluate(() => window.wechatDot.status())).running, 'Start fixture before reconnect test');
    await reopenSetup();
    let releaseSend;
    weixinSendGate = new Promise(resolve => { releaseSend = resolve; });
    const beforeSend = sendRequests, beforeQr = qrRequests, beforeLoginPage = draftPolls;
    messages.push({ id: `reconnect-cancel-${account}-${cancel}`, account_user_id: 'dot-member', content: { text: '重连前正在发送的回复' } });
    await waitFor(() => sendRequests > beforeSend, 'Hold a send while reconnect begins');
    await pausedRestart.evaluate(account => { window.fixtureReconnect = [window.wechatDot.action(`recover-${account}`), window.wechatDot.action(`recover-${account}`)]; }, account);
    if (cancel) await pausedRestart.evaluate(() => { window.fixturePause = window.wechatDot.action('pause'); });
    releaseSend(); weixinSendGate = undefined;
    await pausedRestart.evaluate(() => Promise.all(window.fixtureReconnect));
    if (cancel) await pausedRestart.evaluate(() => window.fixturePause);
    if (!cancel && account === 'dot' && externalBrowser) {
      await waitFor(() => draftPolls > beforeLoginPage, 'Reconnect login page did not load', 45000);
      await pausedRestart.getByRole('button', { name: '登录完成，识别 dot' }).click();
    }
    await waitFor(async () => Boolean((await pausedRestart.evaluate(() => window.wechatDot.status())).running) === !cancel, 'Repeated reconnect must preserve intent and respect a later pause');
    assert.equal(qrRequests - beforeQr, !cancel && account === 'weixin' ? 1 : 0, 'Duplicate reconnect must share one login; cancelled reconnect must never open a QR');
    if (cancel) {
      await new Promise(r => setTimeout(r, 300));
      assert.equal((await pausedRestart.evaluate(() => window.wechatDot.status())).running, false);
      assert.equal(JSON.parse(await readFile(join(data, 'state.json'), 'utf8')).enabled, false);
    }
  }
  await pausedRestart.evaluate(() => window.wechatDot.action('start'));
  await waitFor(async () => (await pausedRestart.evaluate(() => window.wechatDot.status())).running, 'Resume fixture for subsequent cancellation checks');
  if (!extensionContext) for (const closeFirst of [false, true]) {
    if (closeFirst) {
      await pausedRestart.evaluate(() => window.wechatDot.action('start'));
      await waitFor(async () => (await pausedRestart.evaluate(() => window.wechatDot.status())).running, 'Fixture restart did not complete');
    }
    let releaseSend;
    weixinSendGate = new Promise(resolve => { releaseSend = resolve; });
    const beforeBlockedSend = sendRequests;
    messages.push({ id: `pause-drain-${closeFirst}`, account_user_id: 'dot-member', content: { text: '暂停前已发出的回复' } });
    await waitFor(() => sendRequests > beforeBlockedSend, 'The fixture must hold an in-flight send');
    const beforePausedClose = sessionRequests;
    if (closeFirst) { await closeManagedBrowser(); await new Promise(r => setTimeout(r, 500)); }
    await pausedRestart.evaluate(() => { window.fixturePause = window.wechatDot.action('pause'); });
    await pausedRestart.evaluate(() => window.wechatDot.status());
    if (!closeFirst) { await closeManagedBrowser(); await new Promise(r => setTimeout(r, 500)); }
    releaseSend(); weixinSendGate = undefined;
    await pausedRestart.evaluate(() => window.fixturePause);
    await new Promise(r => setTimeout(r, 500));
    assert.equal(sessionRequests, beforePausedClose, 'Recovery must wait for the old send to finish and respect an explicit pause');
    assert.equal((await pausedRestart.evaluate(() => window.wechatDot.status())).running, false);
    assert.equal(JSON.parse(await readFile(join(data, 'state.json'), 'utf8')).enabled, false);
  } else await pausedRestart.evaluate(() => window.wechatDot.action('pause'));
  console.log('PASS: saved login checked before forwarding, closed browser recovered, cancellation and paused restart preserved.');
  console.log('PASS: denied login and polling pause requests until the user explicitly retries.');
  console.log('PASS: real Electron UI, tray lifecycle, QR fixture, draft attachments, native text reply, dedup, restart and proactive message.' + (externalBrowser ? ' External-browser crash recovery also passed.' : '') + ' These are local fixtures, not live accounts.');
} catch (e) {
  if (externalBrowser && process.platform === 'win32') {
    const script = `$identity = [Security.Principal.WindowsIdentity]::GetCurrent(); $principal = [Security.Principal.WindowsPrincipal]::new($identity); Write-Output ('Elevated: ' + $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)); Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:WECHAT_DOT_FIXTURE_PROFILE) } | Select-Object ProcessId, ParentProcessId, SessionId, CommandLine | ConvertTo-Json -Depth 3`;
    console.log('FIXTURE WINDOWS PROCESSES', await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, WECHAT_DOT_FIXTURE_PROFILE: data }, timeout: 10000 }).then(r => r.stdout).catch(error => error.message));
  }
  console.log('FIXTURE DRAFT', { draftAttachment, draftPolls, lastDraftPoll });
  console.log('FIXTURE REQUESTS', requests);
  console.log('FIXTURE DELIVERIES', { sent, nativeSends });
  const saved = await readFile(join(data, 'state.json'), 'utf8').then(JSON.parse).catch(() => undefined);
  console.log('FIXTURE QUEUES', saved && { inbound: saved.inbound, outbound: saved.outbound });
  if (externalBrowser && !browserPort) browserPort = await readFile(join(data, browserProfile, 'DevToolsActivePort'), 'utf8').then(value => value.split('\n')[0]).catch(() => undefined);
  if (browserPort) {
    console.log('FIXTURE TARGETS', await fetch(`http://127.0.0.1:${browserPort}/json/list`, { signal: AbortSignal.timeout(3000) }).then(r => r.json()).catch(e => e.message));
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${browserPort}`, { noDefaults: true, timeout: 2000 }).catch(() => undefined);
    if (browser) {
      for (const page of browser.contexts()[0].pages()) {
        console.log('FIXTURE BROWSER', page.url(), await page.evaluate(() => ({ visibility: document.visibilityState, draft: Boolean(document.getElementById('attachment')), text: document.querySelector('[contenteditable]')?.innerText, charset: document.characterSet, buttons: [...document.querySelectorAll('button')].map(b => b.getAttribute('aria-label')) })).catch(() => 'unavailable'));
      }
      await browser.close();
    }
  }
  if (desktop) {
    console.log('FIXTURE BROWSER EVENTS', await desktop.evaluate(() => globalThis.fixtureBrowserEvents).catch(() => []));
    for (const p of desktop.windows()) console.log('FIXTURE WINDOW', p.url());
    console.log('FIXTURE STATUS', await (await desktop.firstWindow()).evaluate(() => window.wechatDot.status()).catch(() => 'App exited'));
    console.log('FIXTURE STATUS CHANGES', await (await desktop.firstWindow()).evaluate(() => window.fixtureStatusChanges).catch(() => []));
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
