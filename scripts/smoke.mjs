import { _electron as electron } from 'playwright-core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const data = await mkdtemp(join(tmpdir(), 'wechat-dot-smoke-'));
let desktop;
try {
  desktop = await electron.launch({ ...(process.env.WECHAT_DOT_EXECUTABLE ? { executablePath: process.env.WECHAT_DOT_EXECUTABLE, args: [] } : { args: ['.'] }), env: { ...process.env, WECHAT_DOT_DATA: data }, timeout: 60000 });
  const page = await desktop.firstWindow();
  await page.getByRole('heading', { name: 'WeChat Dot', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /开始连接/ }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '登录 ChatGPT', exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: '安装 Chrome 扩展', exact: true }).isVisible(), false);
  await page.screenshot({ path: 'assets/screenshot.png', scale: 'css' });
  console.log('PASS: desktop launches with a fresh profile; connect waits for both accounts; no extension setup is shown.');
} finally { if (desktop) await desktop.close(); await rm(data, { recursive: true, force: true }); }
