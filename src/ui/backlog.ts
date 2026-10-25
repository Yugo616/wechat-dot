import type { AppStatus, BacklogSnapshot } from '../types';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id)! as T;
export class BacklogView {
  private snapshot?: BacklogSnapshot;
  private selected = new Set<string>();
  private busy = false;
  private request = 0;
  private running = false;
  private readonly panel = element('backlog-panel');
  private readonly list = element('backlog-list');
  private readonly selectAll = element<HTMLInputElement>('backlog-select-all');
  constructor() {
    element('backlog-open').onclick = () => {
      element('connection-panel').hidden = true; this.panel.hidden = false;
      element('backlog-feedback').textContent = '';
      void this.refresh();
    };
    element('backlog-close').onclick = () => { this.panel.hidden = true; element('connection-panel').hidden = false; };
    this.selectAll.onchange = () => {
      this.selected = new Set(this.selectAll.checked ? this.snapshot?.items.map(item => item.key) : []);
      this.list.querySelectorAll<HTMLInputElement>('input').forEach(input => { input.checked = this.selected.has(input.value); });
      this.controls();
    };
    element('backlog-restore-selected').onclick = () => { void this.manage('restore', [...this.selected]); };
    element('backlog-restore-all').onclick = () => { void this.manage('restore', this.snapshot?.items.map(item => item.key) ?? []); };
    element('backlog-clear').onclick = () => { void this.manage('clear', this.snapshot?.items.map(item => item.key) ?? []); };
  }
  update(status: AppStatus): void {
    this.running = status.running;
    element('backlog-hint').textContent = status.running ? '恢复后继续发送，已发出的部分不会重发。' : '当前已暂停。恢复后，点击「开始转发」再发送。';
    if (!this.panel.hidden && !this.busy && (status.backlogConnection !== this.snapshot?.connection || status.skippedMessages !== this.snapshot?.items.length)) void this.refresh();
  }
  private controls(): void {
    const count = this.snapshot?.items.length ?? 0;
    this.selectAll.disabled = this.busy || !count;
    this.selectAll.checked = count > 0 && this.selected.size === count;
    this.selectAll.indeterminate = this.selected.size > 0 && this.selected.size < count;
    for (const button of this.panel.querySelectorAll<HTMLButtonElement>('button[data-backlog]')) button.disabled = this.busy || !count;
    const selected = element<HTMLButtonElement>('backlog-restore-selected');
    selected.textContent = `恢复所选（${this.selected.size}）`;
    selected.disabled = this.busy || !this.selected.size;
  }
  private display(snapshot: BacklogSnapshot): void {
    if (snapshot.connection !== this.snapshot?.connection) this.selected.clear();
    const keys = new Set(snapshot.items.map(item => item.key));
    this.selected = new Set([...this.selected].filter(key => keys.has(key)));
    this.snapshot = snapshot;
    const scroll = this.list.scrollTop;
    const nodes = snapshot.items.map(item => {
      const row = document.createElement('div'); row.className = 'backlog-row';
      const input = document.createElement('input'); input.type = 'checkbox'; input.value = item.key; input.checked = this.selected.has(item.key);
      input.setAttribute('aria-label', `选择${item.direction === 'inbound' ? '微信问题' : 'dot 回复'}：${item.text}`);
      input.onchange = () => { if (input.checked) this.selected.add(item.key); else this.selected.delete(item.key); this.controls(); };
      const content = document.createElement('div'); content.className = 'backlog-content';
      const meta = document.createElement('div'); meta.className = 'backlog-meta';
      const direction = document.createElement('span'); direction.textContent = item.direction === 'inbound' ? '微信 → dot' : 'dot → 微信';
      const time = document.createElement('time'); time.textContent = item.timestamp ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(item.timestamp) : '';
      meta.append(direction, time);
      const text = document.createElement('p'); text.className = 'backlog-text'; text.textContent = item.text; text.title = item.text;
      content.append(meta, text);
      if (item.partial) { const part = document.createElement('small'); part.textContent = '仅恢复未发送的部分'; content.append(part); }
      const button = document.createElement('button'); button.type = 'button'; button.textContent = '恢复'; button.dataset.backlog = 'restore'; button.className = 'outline';
      button.onclick = () => { void this.manage('restore', [item.key]); };
      row.append(input, content, button); return row;
    });
    this.list.replaceChildren(...nodes); this.list.scrollTop = scroll;
    element('backlog-empty').hidden = Boolean(nodes.length);
    element('backlog-total').textContent = `${nodes.length} 条`;
    this.controls();
  }
  private async refresh(): Promise<void> {
    const request = ++this.request;
    this.busy = true; this.controls();
    try { const snapshot = await window.wechatDot.backlog(); if (request === this.request) this.display(snapshot); }
    catch { element('backlog-feedback').textContent = '列表读取失败，返回后重新打开即可。'; }
    finally { if (request === this.request) { this.busy = false; this.controls(); } }
  }
  private async manage(action: 'restore' | 'clear', keys: string[]): Promise<void> {
    if (this.busy || !this.snapshot || !keys.length) return;
    ++this.request;
    this.busy = true; this.controls();
    try {
      const result = await window.wechatDot.manageBacklog(action, { connection: this.snapshot.connection, keys });
      this.display(result.snapshot);
      element('backlog-feedback').textContent = action === 'clear' ? `已清空 ${result.changed} 条暂存消息。` : `已恢复 ${result.changed} 条消息。${this.running ? '正在继续发送。' : '开始转发后发送。'}`;
    } catch (error) {
      await this.refresh();
      element('backlog-feedback').textContent = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '操作未完成，请重试。';
    } finally { this.busy = false; this.controls(); }
  }
}
