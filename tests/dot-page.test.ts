import test from 'node:test';
import assert from 'node:assert/strict';
import { dotPageAction } from '../src/dot/page';

test('resuming a textarea uses its current value, never its empty or stale child text', async t => {
  class Element {
    value = '用户另外写的草稿';
    innerText = '';
    tagName = 'TEXTAREA';
    isContentEditable = false;
    childNodes: any[] = [];
    getBoundingClientRect() { return { height: 30 }; }
    closest() { return { querySelectorAll: () => [{ files: [{ name: 'queued.pdf' }] }] }; }
  }
  const input = new Element();
  const replacements = { Node: { TEXT_NODE: 3 }, HTMLElement: Element, HTMLBRElement: class {},
    document: { querySelector: () => input } };
  const globals = globalThis as any;
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globals, key)]));
  Object.assign(globals, replacements);
  t.after(() => { for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globals, key, descriptor); else delete globals[key]; } });
  for (const text of ['', '旧的默认文字']) {
    input.childNodes = text ? [{ nodeType: 3, textContent: text }] : [];
    const args = { text, names: ['queued.pdf'], composerSelectors: ['textarea'], attachmentSelectors: [], resumeDraft: true };
    assert.deepEqual(await dotPageAction('owned-draft', args), { ok: true, value: false });
    assert.deepEqual(await dotPageAction('composer', args), { ok: true, value: 'draft' });
    assert.equal(input.value, '用户另外写的草稿');
  }
});
