import { chromium } from 'playwright-core';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
assert.equal(process.platform, 'win32');
const data = await mkdtemp(join(tmpdir(), 'wechat-dot-native-ui-'));
const exe = resolve(process.env.WECHAT_DOT_EXECUTABLE ?? 'src-tauri/target/release/WeChat Dot.exe');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const exec = promisify(execFile), registry = [];
const shellEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
const elevated = (await exec('powershell.exe', ['-NoProfile', '-Command', '([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'], { env: shellEnv })).stdout.trim() === 'True';
async function browserEnvironment(port) {
  const args = `--remote-debugging-port=${port}`, folder = join(data, `webview-${port}`);
  // Elevated WebView2 ignores environment overrides. CI uses app-specific machine
  // overrides and removes them afterwards; no test hooks are shipped in the app.
  // https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security
  if (elevated) {
    assert.equal(process.env.CI, 'true', 'Run local interface checks without administrator privileges');
    for (const [setting, value] of [['AdditionalBrowserArguments', args], ['UserDataFolder', folder]]) {
      const key = `HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\WebView2\\${setting}`;
      for (const name of [basename(exe), pkg.build.appId]) {
        await exec('reg.exe', ['add', key, '/v', name, '/t', 'REG_SZ', '/d', value, '/f']);
        registry.push([key, name]);
      }
    }
  }
  return { ...process.env, WECHAT_DOT_DATA: data, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: args, WEBVIEW2_USER_DATA_FOLDER: folder };
}
const state = { version: 1, enabled: false, weixinCursor: 'keep', weixin: { userId: 'fixture', botId: 'fixture', token: 'fixture', baseUrl: '' }, dot: { id: 'fixture', userId: 'fixture', accountId: 'fixture', roomId: 'fixture', name: '测试 dot', url: '' },
  inbound: Array.from({ length: 3 }, (_, i) => ({ id: `held-${i}`, phase: 'done', expired: true, message: { create_time_ms: Date.now() - 3600000, item_list: [{ text_item: { text: `测试旧消息 ${i}` } }] } })), outbound: [] };
await writeFile(join(data, 'state.json'), JSON.stringify(state));
let child, browser;
async function launch() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(r => server.close(r));
  child = spawn(exe, [], { env: await browserEnvironment(port), stdio: 'pipe' });
  let log = ''; child.stderr.on('data', b => { log += b; });
  const end = Date.now() + 45000;
  while (true) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }); break; } catch { if (child.exitCode !== null || Date.now() > end) throw new Error(log || 'Native WebView2 did not start'); await new Promise(r => setTimeout(r, 100)); } }
  const context = browser.contexts()[0], page = context.pages()[0] ?? await context.waitForEvent('page');
  await page.getByRole('button', { name: '查看', exact: true }).waitFor(); return page;
}
async function quit(page) { const exit = once(child, 'exit'); await page.evaluate(() => { void window.wechatDot.action('quit'); }).catch(() => {}); await exit; await browser.close().catch(() => {}); browser = undefined; }
try {
  let page = await launch();
  await page.getByRole('button', { name: '查看', exact: true }).click();
  assert.equal(await page.locator('.backlog-row').count(), 3);
  await page.locator('.backlog-row').first().getByRole('button', { name: '恢复', exact: true }).click();
  await page.getByText('已恢复 1 条消息。开始转发后发送。', { exact: true }).waitFor();
  await page.locator('.backlog-row').first().getByRole('checkbox').check();
  await page.getByRole('button', { name: '恢复所选（1）' }).click();
  await page.getByRole('button', { name: '恢复所选（0）' }).waitFor();
  await page.getByRole('button', { name: '清空', exact: true }).click();
  await page.getByText('没有暂存消息', { exact: true }).waitFor();
  await page.getByRole('button', { name: '返回', exact: true }).click();
  assert.equal(await page.locator('#backlog-area').isVisible(), false);
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/native-windows.png' });
  await page.getByRole('checkbox', { name: '不再询问' }).check();
  await page.getByRole('button', { name: '最小化', exact: true }).click();
  assert.equal(child.exitCode, null);
  assert.equal((await page.evaluate(() => window.wechatDot.status())).exitAction, 'minimize');
  await quit(page);
  const saved = JSON.parse(await readFile(join(data, 'state.json'), 'utf8'));
  assert.equal(saved.enabled, false); assert.equal(saved.exitAction, 'minimize'); assert.equal(saved.inbound.filter(j => j.phase === 'pending').length, 2); assert.equal(saved.inbound[2].dismissed, true);
  // The restarted native host must show persisted state without a browser login.
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(r => server.close(r));
  child = spawn(exe, [], { env: await browserEnvironment(port), stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 500 }); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  assert.ok(browser); const context = browser.contexts()[0]; page = context.pages()[0] ?? await context.waitForEvent('page');
  await page.getByRole('button', { name: '最小化', exact: true }).waitFor(); assert.equal(await page.locator('#backlog-area').isVisible(), false);
  await quit(page);
  console.log('PASS: installed native WebView2 controls, single/selected/clear, exit prompt, remember choice and paused restart.');
} finally {
  await browser?.close().catch(() => {});
  if (child?.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
  for (const [key, name] of registry) await exec('reg.exe', ['delete', key, '/v', name, '/f']).catch(() => {});
  await rm(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
