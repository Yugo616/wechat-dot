import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { prepareExtension } from '../src/dot/extension-runtime';
import defaults from '../config/defaults.json';

test('a running connection sees complete settings and its token stays out of page scripts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dot-extension-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const source = join(root, 'source'), destination = join(root, 'installed');
  await mkdir(source); await mkdir(destination);
  await writeFile(join(source, 'manifest.json'), JSON.stringify({ content_scripts: [{ matches: [] }] }));
  await writeFile(join(source, 'connection.json'), JSON.stringify({ port: 1234 }));
  const previous = { port: 1, token: randomBytes(32).toString('hex') };
  const next = { port: 2, token: randomBytes(32).toString('hex') };
  const path = join(destination, 'connection.json');
  await writeFile(path, JSON.stringify(previous));
  let finished = false;
  const preparing = prepareExtension(source, destination, defaults.dot, next).finally(() => { finished = true; });
  while (!finished) {
    const current = JSON.parse(await readFile(path, 'utf8'));
    assert.ok(JSON.stringify(current) === JSON.stringify(previous) || JSON.stringify(current) === JSON.stringify(next));
  }
  await preparing;
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), next);
  assert.equal((await readFile(join(destination, 'config.js'), 'utf8')).includes(next.token), false);
  assert.equal(JSON.parse(await readFile(join(destination, 'manifest.json'), 'utf8')).web_accessible_resources, undefined);
});
