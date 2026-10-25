import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { encode } from 'silk-wasm';
import { buildExtension } from '../scripts/extension.mjs';
import { nativeClient } from './native-client.mjs';

const data = await mkdtemp(join(tmpdir(), 'wechat-dot-native-browser-'));
const resources = join(data, 'resources'); await mkdir(resources);
const defaults = JSON.parse(await readFile('config/defaults.json', 'utf8'));
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
let client, pageLoads = 0, incoming = [], sent = [], nativeSends = [], transcripts = 0, ticket;
const messages = [{ id: 'history', account_user_id: 'dot-member', content: { text: '历史不要重发' } }];
const uploaded = new Map(), cdn = [], key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const picture = Buffer.from('89504e470d0a1a0aff0080abcd', 'hex'), document = Buffer.from('native fixture 文档');
const media = new Map([['picture', picture], ['document', document]]);
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, base), chunks = []; for await (const part of req) chunks.push(part);
    const bytes = Buffer.concat(chunks); res.setHeader('Content-Type', 'application/json');
    if (url.pathname.endsWith('/getupdates')) return res.end(JSON.stringify({ ret: 0, msgs: incoming.splice(0), get_updates_buf: 'fixture-position' }));
    if (url.pathname.endsWith('/sendmessage')) { sent.push(JSON.parse(bytes).msg); return res.end('{"ret":0}'); }
    if (url.pathname.endsWith('/getuploadurl')) { ticket = JSON.parse(bytes); return res.end(JSON.stringify({ upload_full_url: `${base}/cdn` })); }
    if (url.pathname === '/cdn') { const cipher = createDecipheriv('aes-128-ecb', Buffer.from(ticket.aeskey, 'hex'), null); cdn.push(Buffer.concat([cipher.update(bytes), cipher.final()])); res.setHeader('x-encrypted-param', 'fixture'); return res.end(); }
    if (url.pathname.startsWith('/media/')) { const cipher = createCipheriv('aes-128-ecb', key, null); return res.end(Buffer.concat([cipher.update(media.get(url.pathname.split('/').at(-1))), cipher.final()])); }
    if (url.pathname === '/api/auth/session') return res.end(JSON.stringify({ accessToken: 'fixture', user: { id: 'fixture-user' } }));
    if (url.pathname.endsWith('/tbo/primary')) return res.end(JSON.stringify({ selection: { available: true, thread_id: 'thread' }, profile: { id: 'fixture-dot', display_name: '测试 dot', messaging_room_id: 'room' } }));
    if (url.pathname === '/backend-api/messaging/rooms/room') return res.end(JSON.stringify({ id: 'room', members: [{ aeon_id: 'fixture-dot', account_user_id: 'dot-member' }] }));
    if (url.pathname === '/backend-api/transcribe') { const form = await new Request(base, { method: 'POST', headers: req.headers, body: bytes }).formData(); const wav = Buffer.from(await form.get('file').arrayBuffer()); assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); transcripts++; return res.end(JSON.stringify({ text: '中文 English 语音' })); }
    if (url.pathname === '/backend-api/messaging/rooms/room/files') {
      const form = await new Request(base, { method: 'POST', headers: req.headers, body: bytes }).formData(); const file = form.get('file');
      const entry = { id: 'file-' + uploaded.size, name: file.name, mime_type: file.type, bytes: Buffer.from(await file.arrayBuffer()) }; uploaded.set(entry.id, entry);
      return res.end(JSON.stringify({ ...entry, bytes: undefined, status: 'ready' }));
    }
    if (url.pathname.startsWith('/backend-api/messaging/rooms/room/files/')) { const file = uploaded.get(url.pathname.split('/').at(-1)); return res.end(JSON.stringify({ ...file, bytes: undefined, download_url: `${base}/download/${file.id}` })); }
    if (url.pathname.startsWith('/download/')) return res.end(uploaded.get(url.pathname.split('/').at(-1)).bytes);
    if (url.pathname === '/backend-api/messaging/rooms/room/messages') {
      if (req.method === 'POST') {
        const body = JSON.parse(bytes); nativeSends.push(body); const id = `user-${nativeSends.length}`;
        messages.push({ id, account_user_id: 'owner-member', request_id: body.request_id, content: body.content });
        const attachments = (body.content.attachments ?? []).map(a => ({ type: 'file', file_id: a.file_id, file: { ...uploaded.get(a.file_id), bytes: undefined } }));
        messages.push({ id: `reply-${nativeSends.length}`, account_user_id: 'dot-member', content: { text: '收到：' + body.content.text, attachments } }); return res.end(JSON.stringify({ id }));
      }
      const items = url.searchParams.has('after') ? messages.slice(messages.findIndex(m => m.id === url.searchParams.get('after')) + 1) : messages.slice(-20);
      return res.end(JSON.stringify({ items, next_cursor: null }));
    }
    if (url.pathname === '/seen') { pageLoads++; return res.end('{}'); }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><form><input type="file" multiple onchange="upload(this.files)"><div contenteditable="true" role="textbox"></div><button type="button" aria-label="发送消息" onclick="send()">发送</button></form><script>
      let files=[];fetch('/seen');
      async function upload(selected){for(const file of selected){const data=new FormData();data.append('file',file);const entry=await fetch('/backend-api/messaging/rooms/room/files',{method:'POST',body:data}).then(r=>r.json());files.push({type:'file',file_id:entry.id});}}
      async function send(){const editor=document.querySelector('[contenteditable]'),request_id=crypto.randomUUID();await fetch('/backend-api/messaging/rooms/room/messages',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer fixture','ChatGPT-Account-Id':'fixture-account'},body:JSON.stringify({content:{text:editor.innerText,attachments:files},request_id,idempotency_token:request_id})});editor.innerText='';files=[];document.querySelector('input').value='';}
    </script>`);
  } catch (error) { console.error(error); res.statusCode = 500; res.end(String(error)); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${server.address().port}`;
const config = { homeUrl: base + '/', pollIntervalMs: 80, requestTimeoutMs: 4000, sendTimeoutMs: 5000 };
await buildExtension(join(resources, 'browser-connection'), config);
await writeFile(join(resources, 'app-update.yml'), '{}');
await writeFile(join(data, 'config.json'), JSON.stringify({ dot: config, weixin: { baseUrl: base, cdnUrl: base, retryDelayMs: 50, longPollTimeoutMs: 500 } }));
await writeFile(join(data, 'state.json'), JSON.stringify({ version: 1, enabled: false, weixin: { userId: 'owner', botId: 'bot', token: 'fixture', baseUrl: base }, weixinCursor: '', inbound: [], outbound: [] }));
const host = { name: 'WeChat Dot', version, isPackaged: false, appDirectory: resolve('dist/native'), resourcesDirectory: resources, userDirectory: data, cacheDirectory: join(data, 'cache'), executablePath: process.execPath, pid: process.pid };
async function waitFor(check, message, timeout = 20000) { const end = Date.now() + timeout; while (!await check()) { if (Date.now() > end) throw new Error(message + '\n' + client.log() + '\n' + JSON.stringify(await client.request('status'))); await new Promise(r => setTimeout(r, 100)); } }
const enqueue = (id, items) => incoming.push({ message_id: id, create_time_ms: Date.now(), from_user_id: 'owner', message_type: 1, message_state: 2, context_token: 'fixture-context', item_list: items });
const ref = name => ({ full_url: `${base}/media/${name}`, aes_key: Buffer.from(key.toString('hex')).toString('base64') });
try {
  client = nativeClient(host); await client.request('action', 'dot');
  await waitFor(() => pageLoads > 0, 'Dedicated browser did not open', defaults.dot.runtime.downloadTimeoutMs + 30000);
  await client.request('action', 'finish-login'); assert.equal((await client.request('status')).dot, 'ready');
  await client.request('action', 'start'); assert.equal((await client.request('status')).running, true);
  enqueue('text', [{ type: 1, text_item: { text: 'native 一句话' } }]); await waitFor(() => sent.length === 1, 'Native text roundtrip failed');
  assert.equal(sent[0].item_list[0].text_item.text, '收到：native 一句话');
  enqueue('files', [{ type: 1, text_item: { text: '图片文件' } }, { type: 2, image_item: { media: ref('picture') } }, { type: 4, file_item: { file_name: '文档.txt', media: ref('document') } }]);
  await waitFor(() => sent.length === 4, 'Native attachments did not roundtrip'); assert.deepEqual(cdn, [picture, document]);
  const silk = await encode(Buffer.alloc(24000 / 5 * 2), 24000); media.set('voice', Buffer.from(silk.data));
  enqueue('voice', [{ type: 3, voice_item: { media: ref('voice') } }]); await waitFor(() => sent.length === 5, 'Bundled silk fallback failed'); assert.equal(transcripts, 1);
  enqueue('voice-text', [{ type: 3, voice_item: { text: '微信转写' } }]); await waitFor(() => sent.length === 6, 'WeChat transcript failed'); assert.equal(transcripts, 1);
  await client.close(); client = nativeClient(host); await waitFor(async () => (await client.request('status')).running, 'Saved connection did not resume');
  assert.equal(sent.length, 6, 'Restart must not replay delivered messages');
  messages.push({ id: 'proactive', account_user_id: 'dot-member', content: { text: '主动消息' } }); await waitFor(() => sent.length === 7, 'Native proactive message failed');
  await client.request('action', 'pause'); await client.close(); client = nativeClient(host); assert.equal((await client.request('status')).running, false);
  console.log('PASS: bundled Node + dedicated browser: login, text, image/file bytes, voice fallback, supplied transcript, proactive reply, dedup and paused restart. Local fixtures only.');
} finally { await client?.close(); server.closeAllConnections(); server.close(); await rm(data, { recursive: true, force: true, maxRetries: 4 }); }
