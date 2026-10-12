import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareBrowserIdentity } from '../src/dot/identity';

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
