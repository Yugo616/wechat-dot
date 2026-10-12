import type { AppStatus } from '../types';
declare global { interface Window { wechatDot: { status(): Promise<AppStatus>; action(name: string, value?: string): Promise<void>; resize(height: number): void; onStatus(callback: (s: AppStatus) => void): void } } }
const el = (id: string) => document.getElementById(id)!;
let current: AppStatus | undefined;
let busy: string | undefined;
function render(s: AppStatus) {
  current = s;
  const labels = { idle: '未绑定', waiting: '处理中', ready: '已绑定', error: '需要处理' };
  for (const name of ['weixin', 'dot'] as const) {
    el(`${name}-badge`).textContent = labels[s[name]]; el(`${name}-badge`).dataset.status = s[name];
    el(`${name}-detail`).textContent = s[name === 'dot' ? 'dotDetail' : 'weixinDetail'];
  }
  el('version').textContent = `v${s.version}`;
  const problem = s.problem || (s.weixin === 'error' ? s.weixinDetail : s.dot === 'error' ? s.dotDetail : s.weixinSendError);
  el('detail').textContent = problem || (s.connecting ? '正在检查登录，稍候会自动开始转发。' : s.detail);
  el('detail').classList.toggle('problem', Boolean(problem));
  el('weixin-button').textContent = s.weixin === 'idle' ? '微信扫码' : '重新扫码';
  el('dot-button').textContent = s.extension ? '连接 Chrome' : s.dot === 'ready' ? '重新登录' : '登录 ChatGPT';
  const qr = el('qr') as HTMLImageElement; if (s.qr) qr.src = s.qr; else qr.removeAttribute('src');
  el('qr-area').hidden = !s.qr; el('verify-area').hidden = !s.verifyRequired;
  const active = s.running || s.connecting;
  el('toggle').dataset.action = active ? 'pause' : 'start';
  el('toggle').textContent = active ? '暂停转发' : '开始转发';
  el('running').textContent = problem || s.needsReview ? '需要处理' : s.running ? '正在转发' : s.connecting ? '正在准备' : '转发已暂停';
  el('status-dot').classList.toggle('active', s.running);
  el('status-dot').classList.toggle('problem', Boolean(problem || s.needsReview));
  el('review').hidden = !s.needsReview;
  el('finish-login').hidden = !s.finishLogin;
  el('extension-area').hidden = !s.extension;
  el('dot-actions').hidden = s.dot === 'idle' || Boolean(s.finishLogin);
  el('recheck').hidden = s.dot === 'ready';
  el('download').textContent = s.updateUrl ? '下载新版本' : '下载与更新';
  for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-action]')) {
    button.disabled = Boolean(busy && busy === button.dataset.action);
  }
  (el('toggle') as HTMLButtonElement).disabled ||= !active && (s.weixin !== 'ready' || s.dot !== 'ready');
}
document.addEventListener('click', async e => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
  if (!button) return;
  busy = button.dataset.action; if (current) render(current);
  try { await window.wechatDot.action(button.dataset.action!, (el('verify-code') as HTMLInputElement).value); }
  finally { busy = undefined; render(await window.wechatDot.status()); }
});
new ResizeObserver(() => window.wechatDot.resize(document.querySelector('main')!.getBoundingClientRect().height)).observe(document.querySelector('main')!);
window.wechatDot.onStatus(render);
void window.wechatDot.status().then(render);
