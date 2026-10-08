// Shared by the dedicated browser and the extension. Keep this function self-contained.
export async function dotPageAction(action: string, args: any = {}): Promise<any> {
  async function perform(): Promise<any> {
  if (action === 'request') {
    const url = new URL(args.url, location.href);
    if (url.origin !== location.origin) throw new Error('dot 请求必须留在当前网站。');
    const r = await fetch(url, { credentials: 'include', headers: args.headers, signal: AbortSignal.timeout(args.timeoutMs) });
    return { status: r.status, text: await r.text() };
  }
  if (action === 'url') return location.href;
  if (action === 'ready') return document.readyState === 'complete';
  const composer = () => (args.composerSelectors as string[]).map(s => document.querySelector<HTMLElement>(s)).find(e => e && e.getBoundingClientRect().height > 0);
  if (action === 'composer') {
    const e = composer();
    if (!e) return 'missing';
    if (((e as HTMLTextAreaElement).value ?? e.innerText ?? '').trim()) return 'draft';
    const form = e.closest('form') ?? e.parentElement;
    for (const selector of args.attachmentSelectors as string[]) {
      for (const item of form?.querySelectorAll<HTMLElement>(selector) ?? []) {
        if (item instanceof HTMLInputElement ? item.files?.length : item.getBoundingClientRect().height > 0) return 'attachment';
      }
    }
    e.focus(); return 'ready';
  }
  if (action === 'insert') {
    const e = composer();
    if (!e) throw new Error('找不到 dot 输入框。');
    e.focus();
    if (!document.execCommand('insertText', false, args.text)) throw new Error('无法填写 dot 输入框，请打开网页检查。');
    return;
  }
  if (action === 'send') {
    const e = (args.sendSelectors as string[]).map(s => document.querySelector<HTMLButtonElement>(s)).find(e => e && !e.disabled && e.getBoundingClientRect().height > 0);
    if (!e) return false;
    e.click(); return true;
  }
  throw new Error('未知的 dot 页面操作。');
  }
  // Chrome can resolve executeScript with null when an injected promise rejects.
  try { return { ok: true, value: await perform() }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

export function pageResult(result: any): any {
  if (!result?.ok) throw new Error(result?.error ?? 'dot 页面没有响应，请打开标签页检查。');
  return result.value;
}
