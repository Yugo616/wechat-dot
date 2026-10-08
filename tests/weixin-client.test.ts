import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import defaults from '../config/defaults.json';
import { WeixinClient } from '../src/weixin/client';

test('WeChat polling uses the saved cursor, bearer token, and channel identity', async t => {
  let seen: any;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    seen = { url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) };
    res.end('{"ret":0,"msgs":[{"message_id":18446744073709551614}],"get_updates_buf":"next"}');
  }).listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  const client = new WeixinClient({ ...defaults.weixin, baseUrl }, '0.1.0', { baseUrl, token: 'test-token', botId: 'bot', userId: 'owner' });
  const result = await client.updates('previous');
  assert.equal(result.get_updates_buf, 'next');
  assert.equal(result.msgs?.[0].message_id, '18446744073709551614');
  assert.equal(seen.url, '/ilink/bot/getupdates');
  assert.equal(seen.headers.authorization, 'Bearer test-token');
  assert.equal(seen.body.get_updates_buf, 'previous');
  assert.equal(seen.body.base_info.bot_agent, 'WeChatDot/0.1.0');
});

test('WeChat expiry reports re-login rather than pretending the send succeeded', async t => {
  const server = createServer((req, res) => res.end('{"ret":-14,"errcode":-14,"errmsg":"expired"}')).listen(0, '127.0.0.1');
  await once(server, 'listening'); t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  const client = new WeixinClient({ ...defaults.weixin, baseUrl }, '0.1.0', { baseUrl, token: 'test-token', botId: 'bot', userId: 'owner' });
  await assert.rejects(client.send([{ type: 1, text_item: { text: 'hi' } }], 'context', 'reply-id'), /重新扫码/);
});
