import { _electron as electron } from 'playwright-core';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const data = await mkdtemp(join(tmpdir(), 'wechat-dot-smoke-'));
let desktop;
try {
  desktop = await electron.launch({ ...(process.env.WECHAT_DOT_EXECUTABLE ? { executablePath: process.env.WECHAT_DOT_EXECUTABLE, args: [] } : { args: ['.'] }), env: { ...process.env, WECHAT_DOT_DATA: data }, timeout: 60000 });
  const page = await desktop.firstWindow();
  await page.getByRole('heading', { name: 'WeChat Dot', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /开始转发/ }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '登录 ChatGPT', exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: '安装 Chrome 扩展', exact: true }).isVisible(), false);
  for (const name of ['检查更新', '退出']) {
    const border = await page.getByRole('button', { name, exact: true }).evaluate(button => {
      const style = getComputedStyle(button);
      return { width: style.borderTopWidth, style: style.borderTopStyle, color: style.borderTopColor };
    });
    assert.equal(border.style, 'solid', `${name} must have a visible border`);
    assert.equal(border.width, '1px');
    assert.notEqual(border.color, 'rgba(0, 0, 0, 0)');
  }
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
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('checkbox', { name: '不再询问' }).check();
  await page.getByRole('button', { name: '最小化', exact: true }).click();
  const waitForHidden = () => desktop.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window.isVisible()) await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Minimize did not hide the window')), 10000);
      window.once('hide', () => { clearTimeout(timer); resolve(); });
    });
  });
  await waitForHidden();
  assert.equal(JSON.parse(await readFile(join(data, 'state.json'), 'utf8')).exitAction, 'minimize');
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await page.getByRole('button', { name: '最小化', exact: true }).click();
  await waitForHidden();
  assert.equal(await page.getByRole('dialog').isVisible(), false);
  console.log('PASS: exit offers minimize/quit; remembering minimize persists and leaves the app running.');
  console.log('PASS: desktop launches with a fresh profile; connect waits for both accounts; no extension setup is shown.');
} finally { if (desktop) await desktop.close(); await rm(data, { recursive: true, force: true }); }
