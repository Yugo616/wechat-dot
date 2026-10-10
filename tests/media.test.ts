import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { encode } from 'silk-wasm';
import defaults from '../config/defaults.json';
import { MediaStore } from '../src/media';
import { WeixinClient } from '../src/weixin/client';
import { WeixinMedia } from '../src/weixin/media';
import { silkToWav } from '../src/weixin/voice';

test('WeChat media preserves bytes across both upstream key encodings and encrypted upload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wechat-dot-media-'));
  const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const bytes = Buffer.from('89504e470d0a1a0aff0080abcd', 'hex');
  const cipher = createCipheriv('aes-128-ecb', key, null);
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  let upload: any;
  const server = createServer(async (req, res) => {
    if (req.url?.startsWith('/download')) return res.end(encrypted);
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (req.url === '/ilink/bot/getuploadurl') {
      upload = JSON.parse(body.toString());
      assert.equal(upload.rawfilemd5, createHash('md5').update(bytes).digest('hex'));
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ upload_full_url: `${base}/upload` }));
    }
    if (req.url === '/upload') {
      const decipher = createDecipheriv('aes-128-ecb', Buffer.from(upload.aeskey, 'hex'), null);
      assert.deepEqual(Buffer.concat([decipher.update(body), decipher.final()]), bytes);
      res.setHeader('x-encrypted-param', 'download-reference');
      return res.end();
    }
    res.statusCode = 404; res.end();
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const store = new MediaStore(directory, defaults.storage);
  const client = new WeixinClient({ ...defaults.weixin, baseUrl: base, cdnUrl: base }, 'test', { token: 'fixture', botId: 'bot', userId: 'owner', baseUrl: base });
  const media = new WeixinMedia(client, store);
  try {
    const image = await media.download({ type: 2, image_item: { media: { full_url: `${base}/download`, aes_key: key.toString('base64') } } }, 'image');
    assert.deepEqual(await readFile(image.path), bytes);
    assert.equal(image.mime, 'image/png');
    const file = await media.download({ type: 4, file_item: { file_name: '../../测试.png', media: { encrypt_query_param: 'fixture', aes_key: Buffer.from(key.toString('hex')).toString('base64') } } }, 'file');
    assert.deepEqual(await readFile(file.path), bytes);
    assert.equal(file.name, '测试.png');
    assert.ok(file.path.startsWith(join(directory, 'media') + sep));
    const item = await media.upload(file);
    assert.equal(upload.media_type, 1);
    assert.equal(item.type, 2);
    assert.equal(item.image_item?.media?.encrypt_query_param, 'download-reference');
    assert.equal(Buffer.from(item.image_item!.media!.aes_key!, 'base64').toString(), upload.aeskey);
    const document = await store.save('document', '测试.pdf', bytes, 'application/pdf');
    const documentItem = await media.upload(document);
    assert.equal(upload.media_type, 3);
    assert.equal(documentItem.type, 4);
    assert.equal(documentItem.file_item?.file_name, '测试.pdf');
  } finally { server.closeAllConnections(); server.close(); await rm(directory, { recursive: true, force: true }); }
});

test('media size limit rejects unknown-length responses and leaves no partial file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wechat-dot-media-limit-'));
  const store = new MediaStore(directory, { ...defaults.storage, maxMediaBytes: 4 });
  try {
    await assert.rejects(store.save('large', 'large.bin', Buffer.alloc(5)), /附件.*大小|附件.*超过/);
    await assert.rejects(store.readResponse(new Response(new Uint8Array(5))), /附件.*大小|附件.*超过/);
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('SILK without a supplied transcript becomes a mono PCM WAV for transcription', async () => {
  const sampleRate = 24000;
  const pcm = Buffer.alloc(sampleRate * 2 / 5);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(2000 * Math.sin(i * 2 * Math.PI * 440 / sampleRate)), i * 2);
  const silk = await encode(pcm, sampleRate);
  const wav = await silkToWav(Buffer.from(silk.data), sampleRate);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), sampleRate);
  assert.ok(wav.length > 44);
});

test('downloaded file names are usable on Windows as well as macOS', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wechat-dot-filenames-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new MediaStore(directory, defaults.storage);
  for (const name of ['报告?.pdf', 'CON.txt', 'aux', '..', 'trailing. ']) {
    const file = await store.save(name, name, Buffer.from('file'));
    assert.doesNotMatch(file.name, /[<>:"/\\|?*]|[. ]$/);
    assert.doesNotMatch(file.name, /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i);
    assert.equal((await readFile(file.path)).toString(), 'file');
  }
});
