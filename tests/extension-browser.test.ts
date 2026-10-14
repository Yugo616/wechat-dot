import test from 'node:test';
import assert from 'node:assert/strict';
import { ExtensionBrowser } from '../src/dot/extension-browser';
import { ExtensionLink } from '../src/dot/extension-link';
import defaults from '../config/defaults.json';

test('a browser close error still releases the local connection listener', async () => {
  class CloseFailure extends ExtensionBrowser {
    protected override async stopManualBrowser(): Promise<void> { throw new Error('OS close failed'); }
  }
  const browser = new CloseFailure(defaults.dot);
  const link = (browser as any).link as ExtensionLink;
  await link.start();
  await assert.rejects(browser.dispose(), /OS close failed/);
  assert.equal((link as any).server, undefined);
  assert.equal((browser as any).lifetime.signal.aborted, true);
});

test('the optional manual extension still discovers without a second login step', async t => {
  const browser = new ExtensionBrowser({ ...defaults.dot, browser: 'extension', extension: { ...defaults.dot.extension, port: 0 } });
  t.after(() => browser.dispose());
  await browser.login();
  assert.equal(browser.manualLogin, false);
});
