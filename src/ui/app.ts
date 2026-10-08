import type { AppStatus } from '../types';
declare global { interface Window { wechatDot: { status(): Promise<AppStatus>; action(name: string, value?: string): Promise<void>; onStatus(callback: (s: AppStatus) => void): void } } }
const el = (id: string) => document.getElementById(id)!;
function render(s: AppStatus) {
  const labels = { idle: '未连接', waiting: '等待登录', ready: '已连接', error: '需要处理' };
  for (const name of ['weixin', 'dot'] as const) {
    el(`${name}-badge`).textContent = labels[s[name]]; el(`${name}-badge`).dataset.status = s[name];
    el(`${name}-detail`).textContent = s[name === 'dot' ? 'dotDetail' : 'weixinDetail'];
  }
  el('dot-name').textContent = s.dotName || '连接你的 dot';
  el('version').textContent = `v${s.version}`;
  el('detail').textContent = s.detail;
  el('weixin-button').textContent = s.weixin === 'idle' ? '微信扫码' : '重新扫码';
  el('dot-button').textContent = s.dot === 'ready' ? '重新登录' : '登录 ChatGPT';
  const qr = el('qr') as HTMLImageElement; if (s.qr) qr.src = s.qr; else qr.removeAttribute('src');
  el('qr-area').hidden = !s.qr; el('verify-area').hidden = !s.verifyRequired;
  el('toggle').dataset.action = s.running ? 'pause' : 'start';
  el('toggle').textContent = s.running ? '暂停连接' : '开始连接 ↗';
  (el('toggle') as HTMLButtonElement).disabled = !s.running && (s.weixin !== 'ready' || s.dot !== 'ready');
  el('running').textContent = s.running ? '正在连接' : '准备连接';
  el('status-dot').classList.toggle('active', s.running);
  el('review').hidden = !s.needsReview;
  el('finish-login').hidden = !s.finishLogin;
  el('download').textContent = s.updateUrl ? '有新版本 ↗' : '下载与更新';
}
document.addEventListener('click', async e => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
  if (!button) return;
  button.disabled = true;
  try { await window.wechatDot.action(button.dataset.action!, (el('verify-code') as HTMLInputElement).value); }
  finally { button.disabled = false; }
});
window.wechatDot.onStatus(render);
void window.wechatDot.status().then(render);
