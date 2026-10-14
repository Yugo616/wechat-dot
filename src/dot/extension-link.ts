import { EventEmitter, once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { restoreError } from '../errors';

export class ExtensionLink extends EventEmitter {
  private server?: WebSocketServer;
  private socket?: WebSocket;
  private heartbeat?: ReturnType<typeof setInterval>;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(readonly config: { port: number; origin: string; token?: string; heartbeatMs: number; maxPayloadBytes: number }, readonly timeoutMs: number) { super(); }
  get connected(): boolean { return this.socket?.readyState === WebSocket.OPEN; }
  get port(): number { const address = this.server?.address(); return typeof address === 'object' && address ? address.port : this.config.port; }
  async start(): Promise<void> {
    if (this.server) return;
    const server = this.server = new WebSocketServer({ host: '127.0.0.1', port: this.config.port, maxPayload: this.config.maxPayloadBytes,
      verifyClient: (info: { origin: string; req: { url?: string } }) => info.origin === this.config.origin && (!this.config.token || info.req.url === `/connect/${this.config.token}`) });
    server.on('connection', socket => {
      if (this.connected) { socket.close(1008, '已有浏览器连接'); return; }
      this.socket = socket;
      socket.on('error', () => {});
      socket.on('message', raw => {
        let data: any; try { data = JSON.parse(String(raw)); } catch { return; }
        if (data.type === 'event') { this.emit('network', data.method, data.params); return; }
        const pending = this.pending.get(data.id); if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(data.id);
        if (data.error) pending.reject(restoreError(String(data.error), data.errorName)); else pending.resolve(data.result);
      });
      socket.on('close', () => {
        if (this.socket !== socket) return;
        this.socket = undefined;
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('ChatGPT 浏览器已断开，正在恢复。')); }
        this.pending.clear(); this.emit('disconnected');
      });
      this.emit('connected');
    });
    await once(server, 'listening');
    this.heartbeat = setInterval(() => { if (this.connected) this.socket!.send('{"type":"ping"}'); }, this.config.heartbeatMs);
    this.heartbeat.unref();
  }
  async waitForConnection(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.connected) return;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    try { await once(this, 'connected', { signal: AbortSignal.any([signal, timeout]) }); }
    catch (error) {
      signal.throwIfAborted();
      if (timeout.aborted) throw new Error('专用浏览器连接超时，请重连 dot。');
      throw error;
    }
  }
  request(action: string, args: any = {}): Promise<any> {
    if (!this.connected) return Promise.reject(new Error('ChatGPT 浏览器已断开，正在恢复。'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('ChatGPT 页面响应超时，请重连 dot。')); }, this.timeoutMs + (args.args?.timeoutMs ?? 0));
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ id, action, args }));
    });
  }
  async stop(): Promise<void> {
    clearInterval(this.heartbeat);
    const server = this.server; this.server = undefined;
    if (!server) return;
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
