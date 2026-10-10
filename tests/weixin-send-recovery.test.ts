import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import defaults from '../config/defaults.json';
import { Bridge } from '../src/bridge';
import { StateStore } from '../src/state';
import { WeixinClient, WeixinSendRejectedError } from '../src/weixin/client';
import { acceptWeixin } from '../src/queue';

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await delay(5);
  assert.ok(check(), 'Expected bridge progress before the deadline');
}

test('a rejected WeChat reply waits across restart without blocking new questions, then resumes on a fresh message', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wechat-dot-rejected-'));
  let rejectSend = true, dotPolls = 0, weixinPolls = 0;
  const received: any[] = [], sends: any[] = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (request.url === '/ilink/bot/sendmessage') {
      sends.push(body.msg);
      response.end(JSON.stringify(rejectSend ? { ret: -2, errmsg: 'prepare failed' } : { ret: 0, message_id: 'delivered' }));
    } else {
      weixinPolls++;
      response.end(JSON.stringify({ ret: 0, msgs: received.splice(0), get_updates_buf: String(weixinPolls) }));
    }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  const config = { ...defaults, weixin: { ...defaults.weixin, baseUrl, retryDelayMs: 5 }, dot: { ...defaults.dot, pollIntervalMs: 5 } };
  const store = new StateStore(directory); await store.load();
  const message = (id: string, context: string) => ({ message_id: id, from_user_id: 'owner', message_type: 1, message_state: 2, context_token: context, item_list: [{ type: 1, text_item: { text: '继续' } }] });
  await store.update(s => {
    s.weixin = { userId: 'owner', botId: 'bot', baseUrl, token: 'fixture-token' };
    s.weixinPrimed = true; s.dotCursor = 'latest'; s.contextToken = 'old-context';
    s.inbound = [{ id: 'question', phase: 'pending', message: message('question', 'old-context') }];
    s.outbound = [{ id: 'reply', part: 0, phase: 'pending', message: { id: 'reply', text: '待发回复', complete: true, createdAt: '', attachments: [] } }];
  });
  const dot = {
    profile: { id: 'dot' }, members: new Set(),
    messages: async () => { dotPolls++; return []; },
    send: async (_text: string, _files: unknown[], requested: (id: string) => Promise<void>, submitted: () => Promise<void>) => {
      await requested('request'); await submitted(); return 'dot-received';
    }
  };
  const status: any = {};
  let active = store;
  let bridge = new Bridge(active, new WeixinClient(config.weixin, 'test', active.data.weixin), dot as any, config, patch => Object.assign(status, patch));
  t.after(async () => { await bridge.pause(); server.closeAllConnections(); server.close(); await rm(directory, { recursive: true, force: true }); });
  await bridge.start(); await until(() => dotPolls >= 4);
  assert.equal(sends.length, 1, 'An explicit send rejection must not be retried every poll');
  await until(() => active.data.inbound[0].phase === 'done');
  assert.equal(active.data.outbound[0].phase, 'pending');
  assert.equal(active.data.outbound[0].part, 0);
  assert.equal(status.weixin, 'ready', 'A send wait must not disable starting the receiver after a pause');
  assert.ok(status.weixinSendError, 'Successful polling must not hide a send rejection');
  await bridge.pause();

  active = new StateStore(directory); await active.load();
  bridge = new Bridge(active, new WeixinClient(config.weixin, 'test', active.data.weixin), dot as any, config, patch => Object.assign(status, patch));
  const previousPolls = dotPolls;
  await bridge.start(); await until(() => dotPolls >= previousPolls + 3);
  assert.equal(sends.length, 1, 'Restart must preserve the wait for fresh WeChat activity');
  received.push(message('question', 'replayed-context'));
  const beforeReplay = weixinPolls;
  await until(() => weixinPolls >= beforeReplay + 3);
  assert.equal(sends.length, 1, 'A replayed message must not trigger another send attempt');
  assert.equal(active.data.contextToken, 'old-context', 'Replayed messages must not replace the latest reply context');

  rejectSend = false;
  received.push(message('new-question', 'fresh-context'));
  await until(() => active.data.outbound[0].phase === 'done' && active.data.inbound[1]?.phase === 'done');
  assert.equal(sends.length, 2);
  assert.equal(sends[1].context_token, 'fresh-context');
  assert.equal(sends[1].client_id, sends[0].client_id, 'Recovery must keep the original delivery ID');
  assert.equal(status.weixin, 'ready');
  assert.equal(status.weixinSendError, undefined);
});

for (const context of ['same-context', 'changed-context', undefined]) test(`an in-flight rejection checks fresh owner reply context: ${context ?? 'missing'}`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wechat-dot-rejection-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new StateStore(directory); await store.load();
  await store.update(s => {
    s.weixin = { userId: 'owner', botId: 'bot', baseUrl: '', token: '' }; s.contextToken = 'same-context';
    s.inbound = [{ id: 'old', phase: 'done', message: { context_token: 'same-context' } }];
    s.outbound = [{ id: 'reply', part: 0, phase: 'pending', message: { id: 'reply', text: '回复', complete: true, createdAt: '', attachments: [] } }];
  });
  let started!: () => void, reject!: () => void;
  const sending = new Promise<void>(resolve => { started = resolve; });
  const release = new Promise<void>(resolve => { reject = resolve; });
  const bridge = new Bridge(store, { send: async () => { started(); await release; throw new WeixinSendRejectedError(); } } as any, {} as any, defaults, () => {});
  const delivery = (bridge as any).deliver(new AbortController().signal);
  await sending;
  await acceptWeixin(store, [{ message_id: 'fresh', from_user_id: 'owner', message_type: 1, message_state: 2, context_token: context }]);
  reject(); await delivery;
  assert.equal(store.data.weixinSendError, context ? undefined : new WeixinSendRejectedError().message, 'Only fresh activity with a reply context may clear the wait');
  assert.equal(store.data.contextToken, context ?? 'same-context');
  assert.equal(store.data.outbound[0].part, 0, 'Unconfirmed reply still needs delivery');
});
