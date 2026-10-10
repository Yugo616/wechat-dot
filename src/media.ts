import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { Config } from './config';
import type { LocalFile } from './types';

const extensions: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', zip: 'application/zip', wav: 'audio/wav', silk: 'audio/silk', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
function contentType(bytes: Buffer, name: string): string {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  if (bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return extensions[extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream';
}

export class MediaStore {
  readonly directory: string;
  constructor(directory: string, readonly config: Config['storage']) { this.directory = join(directory, 'media'); }
  checkSize(size: number, limit = this.config.maxMediaBytes): void {
    if (size > limit) throw new Error(`附件超过大小限制（${Math.round(this.config.maxMediaBytes / 1024 / 1024)} MB），请缩小后重发。`);
  }
  async readResponse(response: Response, limit = this.config.maxMediaBytes): Promise<Buffer> {
    if (!response.ok) throw new Error(`附件下载失败（HTTP ${response.status}），请稍后重试。`);
    this.checkSize(Number(response.headers.get('content-length') || 0), limit);
    if (!response.body) throw new Error('附件没有内容，请重新发送。');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.length; this.checkSize(size, limit); chunks.push(chunk.value);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    return Buffer.concat(chunks);
  }
  async read(file: LocalFile): Promise<Buffer> {
    this.checkSize((await stat(file.path)).size);
    return readFile(file.path);
  }
  async save(key: string, name: string, bytes: Buffer, mime?: string): Promise<LocalFile> {
    this.checkSize(bytes.length);
    name = basename(name.replaceAll('\\', '/')).replace(/[<>:"|?*\x00-\x1f]/g, '_').trim().replace(/[. ]+$/, '') || '附件';
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
    mime = mime?.split(';')[0] || contentType(bytes, name);
    if (!extname(name)) { const extension = Object.keys(extensions).find(e => extensions[e] === mime); if (extension) name += `.${extension}`; }
    const directory = join(this.directory, createHash('sha256').update(key).digest('hex'));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, name); await writeFile(path, bytes, { mode: 0o600 });
    return { path, name, mime };
  }
  async cleanup(keep: Set<string>): Promise<void> {
    const cutoff = Date.now() - this.config.mediaRetentionHours * 60 * 60 * 1000;
    for (const folder of await readdir(this.directory, { withFileTypes: true }).catch(() => [])) {
      if (!folder.isDirectory()) continue;
      const directory = join(this.directory, folder.name);
      for (const name of await readdir(directory)) {
        const path = join(directory, name);
        if (!keep.has(path) && (await stat(path)).mtimeMs < cutoff) await rm(path);
      }
      if (!(await readdir(directory)).length) await rm(directory, { recursive: true });
    }
  }
}
