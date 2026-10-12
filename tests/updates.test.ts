import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { UpdateController } from '../src/updates/controller';

class Feed extends EventEmitter {
  version: string | undefined = '1.1.0';
  failure?: Error;
  checks = 0; downloads = 0;
  async checkForUpdates() {
    this.checks++;
    if (this.failure) throw this.failure;
    if (this.version) this.emit('update-available', { version: this.version });
    else this.emit('update-not-available');
    return null;
  }
  async downloadUpdate() {
    this.downloads++;
    this.emit('download-progress', { percent: 45.6 });
    this.emit('update-downloaded', { version: this.version, downloadedFile: '/fixture/update.zip' });
    return ['/fixture/update.zip'];
  }
}
test('checking downloads a newer version but only an explicit install restarts the app', async () => {
  const feed = new Feed(); const states: string[] = []; const installs: string[] = [];
  const update = new UpdateController(feed, s => states.push(s.phase), async file => { installs.push(file); });
  await update.check();
  assert.equal(update.state.phase, 'ready');
  assert.equal(update.state.version, '1.1.0');
  assert.deepEqual(installs, []);
  assert.ok(states.includes('downloading'));
  await update.install();
  assert.deepEqual(installs, ['/fixture/update.zip']);
});
test('repeated clicks share one check and a ready download is not discarded', async () => {
  const feed = new Feed(); const update = new UpdateController(feed, () => {}, async () => {});
  await Promise.all([update.check(), update.check()]);
  await update.check();
  assert.equal(feed.checks, 1); assert.equal(feed.downloads, 1);
});
test('a failed check can be retried and current versions do not download anything', async () => {
  const feed = new Feed(); const update = new UpdateController(feed, () => {}, async () => {});
  feed.failure = new Error('network offline'); await update.check();
  assert.equal(update.state.phase, 'error');
  assert.match(update.state.message!, /network offline/);
  feed.failure = undefined; feed.version = undefined; await update.check();
  assert.equal(update.state.phase, 'current'); assert.equal(feed.downloads, 0);
});
test('a failed installation keeps the downloaded update available for retry', async () => {
  const feed = new Feed(); let calls = 0;
  const update = new UpdateController(feed, () => {}, async () => { if (++calls === 1) throw new Error('read-only directory'); });
  await update.check(); await update.install();
  assert.equal(update.state.phase, 'ready'); assert.match(update.state.message!, /read-only directory/);
  await update.install(); assert.equal(calls, 2); assert.equal(feed.downloads, 1);
});
