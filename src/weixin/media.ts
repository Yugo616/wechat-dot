// CDN wire format and AES handling adapted from Tencent openclaw-weixin (MIT).
// See THIRD_PARTY_NOTICES.md.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { LocalFile, WeixinItem } from '../types';
import { MediaStore } from '../media';
import { WeixinClient } from './client';

function aesKey(encoded: string): Buffer {
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 16) return bytes;
  if (bytes.length === 32 && /^[a-f0-9]{32}$/i.test(bytes.toString())) return Buffer.from(bytes.toString(), 'hex');
  throw new Error('微信附件的解密信息不完整，请重新发送该附件。');
}

export class WeixinMedia {
  constructor(readonly client: WeixinClient, readonly store: MediaStore) {}
  async download(item: WeixinItem, key: string): Promise<LocalFile> {
    const media = item.image_item?.media ?? item.file_item?.media ?? item.voice_item?.media;
    if (!media?.full_url && !media?.encrypt_query_param) throw new Error('微信附件缺少下载地址，请重新发送该附件。');
    const url = media.full_url || `${this.client.config.cdnUrl}/download?${new URLSearchParams({ encrypted_query_param: media.encrypt_query_param! })}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(this.client.config.requestTimeoutMs) });
    let bytes = await this.store.readResponse(response, this.store.config.maxMediaBytes + 16);
    const encoded = item.image_item?.aeskey ? Buffer.from(item.image_item.aeskey, 'hex').toString('base64') : media.aes_key;
    if (encoded) {
      const decipher = createDecipheriv('aes-128-ecb', aesKey(encoded), null);
      bytes = Buffer.concat([decipher.update(bytes), decipher.final()]);
    } else if (!item.image_item) throw new Error('微信附件缺少解密信息，请重新发送该附件。');
    return this.store.save(key, item.file_item?.file_name || (item.voice_item ? '语音.silk' : '图片'), bytes, item.voice_item ? 'audio/silk' : undefined);
  }
  async upload(file: LocalFile): Promise<WeixinItem> {
    if (!this.client.account) throw new Error('请先连接微信。');
    const bytes = await this.store.read(file), key = randomBytes(16), filekey = randomBytes(16).toString('hex');
    const cipher = createCipheriv('aes-128-ecb', key, null);
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const image = file.mime.startsWith('image/');
    const target = await this.client.request('/ilink/bot/getuploadurl', {
      filekey, media_type: image ? 1 : 3, to_user_id: this.client.account.userId,
      rawsize: bytes.length, rawfilemd5: createHash('md5').update(bytes).digest('hex'), filesize: encrypted.length,
      no_need_thumb: true, aeskey: key.toString('hex')
    });
    if (!target.upload_full_url && !target.upload_param) throw new Error('微信没有返回附件上传地址，请稍后重试。');
    const url = target.upload_full_url || `${this.client.config.cdnUrl}/upload?${new URLSearchParams({ encrypted_query_param: target.upload_param, filekey })}`;
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(encrypted), signal: AbortSignal.timeout(this.client.config.requestTimeoutMs) });
    if (!response.ok) throw new Error(`微信附件上传失败（HTTP ${response.status}），请稍后重试。`);
    const param = response.headers.get('x-encrypted-param');
    if (!param) throw new Error('微信没有确认附件上传，请稍后重试。');
    const media = { encrypt_query_param: param, aes_key: Buffer.from(key.toString('hex')).toString('base64'), encrypt_type: 1 };
    return image ? { type: 2, image_item: { media, mid_size: encrypted.length } }
      : { type: 4, file_item: { media, file_name: file.name, len: String(bytes.length) } };
  }
}
