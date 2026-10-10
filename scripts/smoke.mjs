import { _electron as electron } from 'playwright-core';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  const screenshot = await desktop.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'));
    if (!window.isVisible()) await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('The initial settings window did not appear')), 10000);
      window.once('show', () => { clearTimeout(timer); resolve(); });
    });
    const captured = await window.webContents.capturePage();
    if (captured.isEmpty()) throw new Error('The settings window screenshot is empty');
    return captured.toPNG().toString('base64');
  });
  await writeFile('assets/screenshot.png', Buffer.from(screenshot, 'base64'));
  console.log('PASS: desktop launches with a fresh profile; connect waits for both accounts; no extension setup is shown.');
} finally { if (desktop) await desktop.close(); await rm(data, { recursive: true, force: true }); }
