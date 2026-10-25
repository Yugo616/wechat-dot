import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export async function writeNativeNotices(destination) {
  const entries = [], lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  for (const [directory, info] of Object.entries(lock.packages)) {
    if (!directory || info.dev || info.link) continue;
    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    entries.push({ name: pkg.name, version: pkg.version, directory, license: pkg.license });
  }
  const exec = promisify(execFile), rust = await exec('rustc', ['-vV']);
  const target = /^host: (.+)$/m.exec(rust.stdout)[1];
  const metadata = JSON.parse((await exec('cargo', ['metadata', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--format-version', '1', '--filter-platform', target], { maxBuffer: 20 * 1024 * 1024 })).stdout);
  for (const pkg of metadata.packages) if (pkg.source) entries.push({ ...pkg, directory: dirname(pkg.manifest_path) });
  const sections = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const files = (await readdir(entry.directory)).filter(name => /^(licen[sc]e|copying|notice)([._-].*)?$/i.test(name));
    if (entry.license_file && !files.includes(entry.license_file)) files.push(entry.license_file);
    const texts = await Promise.all(files.map(name => readFile(join(entry.directory, name), 'utf8').catch(() => '')));
    sections.push(`${entry.name} ${entry.version}\nLicense: ${entry.license ?? 'See upstream license'}\n${texts.filter(Boolean).join('\n')}`);
  }
  await writeFile(join(destination, 'THIRD_PARTY_LICENSES.txt'), sections.join('\n\n' + '='.repeat(72) + '\n\n'));
}
