import type { BrowserIdentity } from './identity';

// A visible mark also survives app-mode windows, which do not show Chrome's profile button.
export function markDedicatedPage(identity: BrowserIdentity): void {
  if (window.top !== window) return;
  const key = '__wechatDotIdentity';
  if ((window as any)[key]) return;
  (window as any)[key] = true;
  const title = `${identity.name} · ChatGPT`;
  const update = () => {
    if (document.title !== title) document.title = title;
    if (!document.body || document.getElementById('wechat-dot-identity')) return;
    const badge = document.createElement('div'); badge.id = 'wechat-dot-identity';
    badge.textContent = identity.name;
    badge.title = '这是 WeChat Dot 的专用窗口，日常浏览记录在你原来的浏览器中。';
    Object.assign(badge.style, { position: 'fixed', right: '12px', bottom: '12px', zIndex: '2147483647',
      padding: '7px 11px', borderRadius: '8px', background: identity.color, color: '#fff',
      font: '12px -apple-system, Segoe UI, sans-serif', pointerEvents: 'none' });
    document.body.append(badge);
  };
  new MutationObserver(update).observe(document, { childList: true, subtree: true });
  update();
}
