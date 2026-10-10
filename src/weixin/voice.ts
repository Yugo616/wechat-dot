// WAV framing follows Tencent openclaw-weixin's MIT-licensed SILK adapter.
import { decode, isWav } from 'silk-wasm';

export async function silkToWav(silk: Buffer, sampleRate: number): Promise<Buffer> {
  if (isWav(silk)) return silk;
  const { data } = await decode(silk, sampleRate);
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + data.byteLength, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.byteLength, 40);
  return Buffer.concat([header, data]);
}
