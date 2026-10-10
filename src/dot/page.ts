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
  if (action === 'transcribe') {
    const url = new URL(args.url, location.href);
    if (url.origin !== location.origin) throw new Error('语音转写必须使用当前 ChatGPT 会话。');
    const bytes = Uint8Array.from(atob(args.base64), c => c.charCodeAt(0));
    const data = new FormData(); data.append('file', new File([bytes], args.name, { type: args.mime }));
    const response = await fetch(url, { method: 'POST', body: data, headers: args.headers, credentials: 'include', signal: AbortSignal.timeout(args.timeoutMs) });
    return { status: response.status, text: await response.text() };
  }
  if (action === 'download') {
    const url = new URL(args.url, location.href), same = url.origin === location.origin;
    const response = await fetch(url, { headers: same ? args.headers : {}, credentials: same ? 'include' : 'omit', signal: AbortSignal.timeout(args.timeoutMs) });
    if (!response.ok) return { status: response.status, sameOrigin: same };
    if (Number(response.headers.get('content-length')) > args.maxBytes) throw new Error('dot 的附件超过大小限制，请在 ChatGPT 中下载。');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > args.maxBytes) throw new Error('dot 的附件超过大小限制，请在 ChatGPT 中下载。');
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return { status: response.status, base64: btoa(binary), mime: response.headers.get('content-type') };
  }
  const composer = () => (args.composerSelectors as string[]).map(s => document.querySelector<HTMLElement>(s)).find(e => e && e.getBoundingClientRect().height > 0);
  const composerText = (e: HTMLElement) => (e as HTMLTextAreaElement).value ?? e.innerText ?? '';
  // Older multiline insertion creates empty blocks that innerText counts twice.
  const draftText = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (node instanceof HTMLBRElement) return '\n';
    const block = (n: Node) => n instanceof HTMLElement && ['DIV', 'P'].includes(n.tagName);
    const children = [...node.childNodes];
    if (block(node) && children.length === 1 && children[0] instanceof HTMLBRElement) return '';
    return children.map((child, index) => ((index && (block(child) || block(children[index - 1]))) ? '\n' : '') + draftText(child)).join('');
  };
  if (action === 'owned-draft') {
    const e = composer();
    if (!e || (composerText(e).trim() && composerText(e) !== args.text && !(e.isContentEditable && draftText(e) === args.text))) return false;
    const form = e.closest('form') ?? e.parentElement;
    const selected = [...form?.querySelectorAll<HTMLInputElement>('input[type="file"]') ?? []].flatMap(input => [...input.files ?? []].map(f => f.name)).sort();
    if (selected.length) return JSON.stringify(selected) === JSON.stringify([...args.names].sort());
    for (const selector of args.attachmentSelectors as string[]) {
      for (const item of form?.querySelectorAll<HTMLElement>(selector) ?? []) {
        if (!(item instanceof HTMLInputElement) && item.getBoundingClientRect().height > 0) return false;
      }
    }
    return true;
  }
  if (action === 'composer') {
    const e = composer();
    if (!e) return 'missing';
    const text = composerText(e);
    const repair = args.resumeDraft && e.isContentEditable && text !== args.text && draftText(e) === args.text;
    if (text.trim() && (!args.resumeDraft || (text !== args.text && !repair))) return 'draft';
    const form = e.closest('form') ?? e.parentElement;
    for (const selector of args.attachmentSelectors as string[]) {
      for (const item of form?.querySelectorAll<HTMLElement>(selector) ?? []) {
        if (item instanceof HTMLInputElement ? item.files?.length : item.getBoundingClientRect().height > 0) return 'attachment';
      }
    }
    e.focus();
    if (repair) {
      const range = document.createRange(); range.selectNodeContents(e);
      const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
      if (!document.execCommand('delete')) throw new Error('无法恢复上一条消息的输入，请打开 dot 检查。');
      return 'ready';
    }
    return text.trim() ? 'composed' : 'ready';
  }
  if (action === 'focus-composer') {
    const e = composer();
    if (!e) throw new Error('找不到 dot 输入框。');
    e.focus(); return;
  }
  if (action === 'insert') {
    const e = composer();
    if (!e) throw new Error('找不到 dot 输入框。');
    e.focus();
    for (const [index, line] of String(args.text).split('\n').entries()) {
      if (index && !document.execCommand('insertLineBreak')) throw new Error('无法在 dot 输入框换行，请打开网页检查。');
      if (line && !document.execCommand('insertText', false, line)) throw new Error('无法填写 dot 输入框，请打开网页检查。');
    }
    return;
  }
  if (action === 'send' || action === 'send-ready') {
    if (args.composerSelectors) {
      const input = composer();
      if (!input || composerText(input) !== args.text) return false;
    }
    const e = (args.sendSelectors as string[]).map(s => document.querySelector<HTMLButtonElement>(s)).find(e => e && !e.disabled && e.getBoundingClientRect().height > 0);
    if (!e) return false;
    if (action === 'send-ready') return true;
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
