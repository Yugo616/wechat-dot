import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stageMacUpdate, finishMacInstall } from '../src/updates/mac-install';
const exec = promisify(execFile);
test('Mac update stages a matching bundle beside the current app without changing it', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dot-upgrade-'));
  try {
    const installed = join(root, 'Installed', 'WeChat Dot.app'), source = join(root, 'WeChat Dot.app');
    await mkdir(join(installed, 'Contents'), { recursive: true }); await writeFile(join(installed, 'Contents', 'keep'), 'old');
    await mkdir(join(source, 'Contents'), { recursive: true });
    await writeFile(join(source, 'Contents', 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>fixture.dot</string><key>CFBundleShortVersionString</key><string>1.1.0</string></dict></plist>`);
    const zip = join(root, 'update.zip'); await exec('/usr/bin/ditto', ['-c', '-k', '--keepParent', source, zip]);
    const staged = await stageMacUpdate(zip, installed, 'fixture.dot', '1.1.0');
    assert.match(await readFile(join(staged.app, 'Contents', 'Info.plist'), 'utf8'), /1.1.0/);
    assert.equal(await readFile(join(installed, 'Contents', 'keep'), 'utf8'), 'old');
    await assert.rejects(stageMacUpdate(zip, installed, 'different.app', '1.1.0'), /不匹配/);
    await assert.rejects(stageMacUpdate(zip, installed, 'fixture.dot', '2.0.0'), /不匹配/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('restart cleanup recognizes the same app reached through a directory alias', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dot-cleanup-alias-'));
  try {
    const directory = join(root, 'apps'), alias = join(root, 'alias');
    const target = join(directory, 'WeChat Dot.app');
    await mkdir(target, { recursive: true }); await symlink(directory, alias);
    const staged = join(directory, '.wechat-dot-update-completed');
    await mkdir(staged); await writeFile(join(staged, 'installed'), '');
    await writeFile(join(staged, 'receipt.json'), JSON.stringify({ target: join(alias, 'WeChat Dot.app'), version: '1.1.0' }));
    await finishMacInstall(target, '1.1.0');
    await assert.rejects(readFile(join(staged, 'receipt.json')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('a successful restart removes its own previous bundle and leaves unrelated staged apps alone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dot-cleanup-'));
  try {
    const target = join(root, 'WeChat Dot.app');
    await mkdir(target);
    const completed = join(root, '.wechat-dot-update-completed'), unrelated = join(root, '.wechat-dot-update-other');
    for (const directory of [completed, unrelated]) {
      await mkdir(directory); await writeFile(join(directory, 'installed'), '');
      await writeFile(join(directory, 'receipt.json'), JSON.stringify({ target: directory === completed ? target : join(root, 'Other.app'), version: '1.1.0' }));
    }
    await finishMacInstall(target, '1.1.0');
    await assert.rejects(readFile(join(completed, 'receipt.json')), { code: 'ENOENT' });
    assert.ok(await readFile(join(unrelated, 'receipt.json')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
