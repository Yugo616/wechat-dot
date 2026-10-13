import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionRetry, connectionSummary } from '../src/status';
import { pageResult } from '../src/dot/page';
import type { AppStatus } from '../src/types';

test('transport failures are retryable while access denial and message errors still need their own action', () => {
  for (const message of ['Failed to fetch', 'fetch failed', '微信连接失败（HTTP 503）', 'ChatGPT 请求失败（HTTP 429）']) {
    assert.match(connectionRetry(new Error(message)) ?? '', /自动重试.*无需操作/);
  }
  for (const message of ['ChatGPT 拒绝访问（HTTP 403）', '微信登录已过期，请重新扫码。', '找不到 dot 输入框。']) {
    assert.equal(connectionRetry(new Error(message)), undefined);
  }
  try { pageResult({ ok: false, error: 'The operation was aborted due to timeout', errorName: 'TimeoutError' }); assert.fail('Expected page error'); }
  catch (error) { assert.match(connectionRetry(error) ?? '', /无需操作/); }
});

test('window and tray distinguish automatic reconnection from an action the user must take', () => {
  const status: AppStatus = { weixin: 'ready', dot: 'ready', running: true, detail: '现在可以在微信里聊天了。', weixinDetail: '扫码绑定已保存', dotDetail: '我的 dot', version: 'test' };
  const retry = connectionRetry(new Error('Failed to fetch'));
  const recovering = connectionSummary({ ...status, dotRetry: retry });
  assert.equal(recovering.title, '正在自动重试'); assert.equal(recovering.attention, false);
  assert.match(recovering.detail, /无需操作/);
  assert.equal(connectionSummary(status).title, '正在转发');
  const expired = connectionSummary({ ...status, dot: 'error', dotDetail: '请重新登录', dotRetry: retry });
  assert.equal(expired.title, '需要处理'); assert.equal(expired.detail, '请重新登录');
  assert.deepEqual(expired.action, { name: 'recover-dot', label: '重连 dot' });
  assert.deepEqual(connectionSummary({ ...status, weixin: 'error', weixinDetail: '请重新扫码' }).action, { name: 'recover-weixin', label: '重连微信' });
  assert.match(connectionSummary({ ...status, weixinSendError: '请在微信里发一句话' }).detail, /手机微信.*发一句话/);
});

test('retry notice does not promise forwarding while paused or hide a rejected reply', () => {
  const status: AppStatus = { weixin: 'ready', dot: 'waiting', running: false, detail: '', weixinDetail: '', dotDetail: '', version: 'test', dotRetry: connectionRetry(new Error('Failed to fetch')) };
  assert.doesNotMatch(connectionSummary(status).detail, /恢复后会继续收发/);
  const rejected = connectionSummary({ ...status, weixinSendError: '请在微信里发一句话，回复已保留。' });
  assert.match(rejected.detail, /手机微信.*发一句话/);
  assert.match(rejected.detail, /自动重试/);
  assert.equal(rejected.action, undefined, 'WeChat runs on the phone; a desktop app must not be required');
});

test('message and unexpected errors always have a relevant action instead of a dead end', () => {
  const status: AppStatus = { weixin: 'ready', dot: 'ready', running: true, detail: '', weixinDetail: '', dotDetail: '', version: 'test' };
  assert.deepEqual(connectionSummary({ ...status, needsReview: true }).action, { name: 'show-dot', label: '打开 dot' });
  assert.deepEqual(connectionSummary({ ...status, problem: 'ChatGPT 输入框里有未发送内容，请先发送或清空。' }).action, { name: 'show-dot', label: '打开 dot' });
  assert.deepEqual(connectionSummary({ ...status, problem: 'dot 消息接口已变化，请检查更新。' }).action, { name: 'check-update', label: '检查更新' });
  assert.deepEqual(connectionSummary({ ...status, problem: '没有找到 Chrome 或 Edge，请安装其中一个后重新登录。' }).action, { name: 'download-browser', label: '下载 Chrome' });
  const unexpected = connectionSummary({ ...status, problem: 'Something went wrong' });
  assert.deepEqual(unexpected.action, { name: 'recover-dot', label: '重连 dot' });
  assert.doesNotMatch(unexpected.detail, /Something went wrong/);
});
