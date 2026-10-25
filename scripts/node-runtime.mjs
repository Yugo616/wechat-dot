import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import extract from 'extract-zip';
const config = JSON.parse(await readFile('config/node-runtime.json', 'utf8'));
export async function prepareNode(directory) {
  const platform = `${process.platform}-${process.arch}`;
  const variant = config.platforms[platform];
  if (!variant) throw new Error(`Unsupported Node runtime target: ${platform}`);
  const name = `node-v${config.version}-${platform.replace('win32-', 'win-')}`;
  const cache = resolve('.cache/node-runtime', name), archive = `${cache}.${variant.archive}`;
  await mkdir(resolve('.cache/node-runtime'), { recursive: true });
  let bytes = await readFile(archive).catch(() => undefined);
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== variant.sha256) {
    const response = await fetch(`${config.baseUrl}/v${config.version}/${name}.${variant.archive}`, { signal: AbortSignal.timeout(300000) });
    if (!response.ok) throw new Error(`Node download failed: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== variant.sha256) throw new Error('Node runtime checksum mismatch');
    await writeFile(archive, bytes);
  }
  await mkdir(cache, { recursive: true });
  if (variant.archive === 'zip') await extract(archive, { dir: cache });
  else await promisify(execFile)('tar', ['-xzf', archive, '-C', cache, `${name}/bin/node`, `${name}/LICENSE`]);
  const windows = process.platform === 'win32';
  const destination = join(directory, windows ? 'node.exe' : 'node');
  await copyFile(join(cache, name, windows ? 'node.exe' : 'bin/node'), destination);
  await chmod(destination, 0o755);
  await copyFile(join(cache, name, 'LICENSE'), join(directory, 'NODE-LICENSE'));
}
