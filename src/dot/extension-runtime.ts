import { mkdir, readdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config';

export async function prepareExtension(source: string, directory: string, config: Config['dot'], connection: { port: number; token: string }): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const file of await readdir(source)) {
    if (file === 'connection.json') continue;
    await writeFile(join(directory, file), await readFile(join(source, file)), { mode: 0o600 });
  }
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  const origin = new URL(config.homeUrl).origin + '/*';
  manifest.key = config.extension.publicKey;
  manifest.host_permissions = [origin];
  for (const script of manifest.content_scripts) script.matches = [origin];
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(directory, 'config.js'), `globalThis.wechatDotConfig = ${JSON.stringify(config)};\n`);
  // Only the extension worker reads this file. Never inject it into the webpage.
  const temporary = join(directory, 'connection.json.tmp');
  await writeFile(temporary, JSON.stringify(connection), { mode: 0o600 });
  await rename(temporary, join(directory, 'connection.json'));
}
