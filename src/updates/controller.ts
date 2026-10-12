export interface UpdateStatus {
  phase: 'idle' | 'checking' | 'current' | 'downloading' | 'ready' | 'installing' | 'error';
  version?: string; percent?: number; message?: string;
}
interface UpdateEngine {
  on(event: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<string[]>;
}

export class UpdateController {
  state: UpdateStatus = { phase: 'idle' };
  private operation?: Promise<void>;
  private file?: string;
  constructor(private engine: UpdateEngine, private publish: (status: UpdateStatus) => void,
    private apply: (file: string, version: string) => Promise<void>) {
    engine.on('update-available', ({ version }) => this.set({ phase: 'downloading', version, percent: 0 }));
    engine.on('update-not-available', () => this.set({ phase: 'current' }));
    engine.on('download-progress', ({ percent }) => this.set({ ...this.state, phase: 'downloading', percent: Math.round(percent) }));
    engine.on('update-downloaded', ({ version, downloadedFile }) => {
      this.file = downloadedFile; this.set({ phase: 'ready', version });
    });
    engine.on('error', error => this.set({ phase: 'error', message: error.message }));
  }
  private set(state: UpdateStatus): void { this.state = state; this.publish(state); }
  check(): Promise<void> {
    if (this.operation) return this.operation;
    if (this.state.phase === 'ready' || this.state.phase === 'installing') return Promise.resolve();
    this.set({ phase: 'checking' });
    const operation = this.operation = Promise.resolve().then(async () => {
      await this.engine.checkForUpdates();
      if (this.state.phase === 'downloading') await this.engine.downloadUpdate();
      else if (this.state.phase === 'checking') this.set({ phase: 'current' });
    }).catch(error => this.set({ phase: 'error', message: error.message }))
      .finally(() => { if (this.operation === operation) this.operation = undefined; });
    return operation;
  }
  async install(): Promise<void> {
    if (this.state.phase !== 'ready' || !this.file || !this.state.version) return;
    const ready = this.state;
    this.set({ ...ready, phase: 'installing', message: undefined });
    try { await this.apply(this.file, ready.version!); }
    catch (error) { this.set({ ...ready, message: (error as Error).message }); }
  }
}
