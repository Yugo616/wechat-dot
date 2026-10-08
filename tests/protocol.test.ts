import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWeixinJson } from '../src/weixin/json';

test('WeChat IDs beyond Number precision retain every digit, including quoted references', () => {
  const data = parseWeixinJson<any>('{"msgs":[{"message_id":18446744073709551614,"seq":7,"ref_msg":{"svr_id":18446744073709551613}}]}');
  assert.equal(data.msgs[0].message_id, '18446744073709551614');
  assert.equal(data.msgs[0].ref_msg.svr_id, '18446744073709551613');
  assert.equal(data.msgs[0].seq, 7);
});

test('quoted message text containing JSON-like IDs is left unchanged', () => {
  const data = parseWeixinJson<any>('{"text":"quote: \\\"message_id\\\":123","message_id":"00123"}');
  assert.equal(data.text, 'quote: "message_id":123');
  assert.equal(data.message_id, '00123');
});
