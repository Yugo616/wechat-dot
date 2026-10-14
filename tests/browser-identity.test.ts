import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareBrowserIdentity } from '../src/dot/identity';
import defaults from '../config/defaults.json';

test('default browser cannot launch the personal Chrome or Edge application', () => {
  const dot = defaults.dot as any;
  assert.equal(dot.browserExecutables, undefined, 'A separate profile still shares the personal browser application identity');
  assert.ok(dot.runtime.platforms['darwin-arm64'].executable.includes('Google Chrome for Testing.app'));
  assert.ok(dot.runtime.platforms['darwin-x64'].executable.includes('Google Chrome for Testing.app'));
  assert.equal(dot.runtime.platforms['win32-x64'].archive, 'chrome-win64.zip');
  assert.notEqual(dot.runtime.profileDirectory, 'ChatGPT Browser', 'Do not attach to a surviving legacy system-Chrome process');
});

test('branding preserves existing login preferences and touches only the dedicated directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dot-identity-'));
  try {
    const dedicated = join(root, 'dot'); const personal = join(root, 'personal');
    for (const folder of [dedicated, personal]) {
      await mkdir(join(folder, 'Default'), { recursive: true });
      await writeFile(join(folder, 'Default', 'Preferences'), JSON.stringify({ profile: { name: 'Old' }, custom: 'keep' }));
      await writeFile(join(folder, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Old', user_name: 'preserve' } } }, custom: true }));
    }
    await prepareBrowserIdentity(dedicated, { name: 'WeChat Dot 专用', color: '#32836d' });
    const changed = JSON.parse(await readFile(join(dedicated, 'Default', 'Preferences'), 'utf8'));
    assert.equal(changed.profile.name, 'WeChat Dot 专用'); assert.equal(changed.custom, 'keep');
    const local = JSON.parse(await readFile(join(dedicated, 'Local State'), 'utf8'));
    assert.equal(local.profile.info_cache.Default.user_name, 'preserve');
    assert.equal(JSON.parse(await readFile(join(personal, 'Default', 'Preferences'), 'utf8')).profile.name, 'Old');
    await prepareBrowserIdentity(dedicated, { name: 'WeChat Dot 专用', color: '#32836d' });
    assert.deepEqual(JSON.parse(await readFile(join(dedicated, 'Default', 'Preferences'), 'utf8')), changed);
  } finally { await rm(root, { recursive: true, force: true }); }
});
