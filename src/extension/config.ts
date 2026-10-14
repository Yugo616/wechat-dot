import defaults from '../../config/defaults.json';
export const config: typeof defaults.dot = (globalThis as any).wechatDotConfig ?? defaults.dot;
