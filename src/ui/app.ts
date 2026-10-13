import type { AppStatus } from '../types';
import { connectionSummary, problemText } from '../status';
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
  const summary = connectionSummary(s);
  el('detail').textContent = summary.detail;
  el('detail').classList.toggle('problem', summary.attention);
  const recovery = el('recovery-button');
  recovery.hidden = !summary.action;
  recovery.textContent = summary.action?.label ?? '';
  recovery.dataset.action = summary.action?.name ?? '';
  const dotAction = ['recover-dot', 'show-dot', 'download-browser'].includes(summary.action?.name ?? '');
  el('weixin-button').hidden = summary.action?.name === 'recover-weixin';
  el('dot-button').hidden = dotAction;
  el('weixin-button').textContent = s.weixin === 'idle' ? '微信扫码' : '重新扫码';
  el('dot-button').textContent = s.extension ? '连接 Chrome' : s.dot === 'ready' ? '重新登录' : '登录 ChatGPT';
  const qr = el('qr') as HTMLImageElement; if (s.qr) qr.src = s.qr; else qr.removeAttribute('src');
  el('qr-area').hidden = !s.qr; el('verify-area').hidden = !s.verifyRequired;
  const active = s.running || s.connecting;
  el('toggle').hidden = !active && ['recover-weixin', 'recover-dot', 'download-browser'].includes(summary.action?.name ?? '');
  el('toggle').dataset.action = active ? 'pause' : 'start';
  el('toggle').textContent = active ? '暂停转发' : '开始转发';
  el('running').textContent = summary.title;
  el('status-dot').classList.toggle('active', s.running && !summary.retrying);
  el('status-dot').classList.toggle('problem', summary.attention);
  el('review').hidden = !s.needsReview;
  el('finish-login').hidden = !s.finishLogin;
  el('extension-area').hidden = !s.extension;
  el('dot-actions').hidden = dotAction || s.dot === 'idle' || Boolean(s.finishLogin);
  el('recheck').hidden = s.dot === 'ready';
  const update = s.update ?? { phase: 'idle' };
  const updating = ['checking', 'downloading', 'installing'].includes(update.phase);
  const updateButton = el('update-button') as HTMLButtonElement;
  updateButton.textContent = update.phase === 'checking' ? '正在检查…' : update.phase === 'downloading' ? `下载中 ${update.percent ?? 0}%` : update.phase === 'ready' ? '重启更新' : update.phase === 'installing' ? '正在安装…' : '检查更新';
  updateButton.dataset.action = update.phase === 'ready' ? 'install-update' : 'check-update';
  el('update-area').hidden = update.phase === 'idle' || update.phase === 'checking';
  if (update.phase === 'error') updateButton.textContent = '重试更新';
  el('update-detail').textContent = update.message ? problemText(update.message, update.phase === 'ready' ? '安装未完成，可再次点击「重启更新」或打开下载页面。' : '暂时无法完成更新，可点击「重试更新」或打开下载页面。') : update.phase === 'current' ? '已是最新版本' : update.phase === 'downloading' ? `正在下载 v${update.version}` : update.phase === 'ready' ? `v${update.version} 已下载，重启后生效` : update.phase === 'installing' ? '正在保存连接并安装更新…' : '';
  el('download').hidden = !update.message;
  for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-action]')) {
    button.disabled = Boolean(busy && busy === button.dataset.action);
  }
  (el('toggle') as HTMLButtonElement).disabled ||= !active && (s.weixin !== 'ready' || s.dot !== 'ready');
  updateButton.disabled ||= updating;
  el('exit-button').textContent = s.exitAction === 'minimize' ? '最小化' : '退出';
  const dialog = el('exit-dialog') as HTMLDialogElement;
  if (s.exitPrompt && !dialog.open) { (el('remember-exit') as HTMLInputElement).checked = false; dialog.showModal(); }
  else if (!s.exitPrompt && dialog.open) dialog.close();
}
document.addEventListener('click', async e => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
  if (!button) return;
  busy = button.dataset.action; if (current) render(current);
  const value = button.dataset.action?.startsWith('exit-') ? ((el('remember-exit') as HTMLInputElement).checked ? 'remember' : '') : (el('verify-code') as HTMLInputElement).value;
  try { await window.wechatDot.action(button.dataset.action!, value); }
  finally { busy = undefined; render(await window.wechatDot.status()); }
});
el('exit-dialog').addEventListener('cancel', () => { void window.wechatDot.action('cancel-exit'); });
new ResizeObserver(() => window.wechatDot.resize(document.querySelector('main')!.getBoundingClientRect().height)).observe(document.querySelector('main')!);
window.wechatDot.onStatus(render);
void window.wechatDot.status().then(render);
