# Backlog Recovery Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add compact recovery/clear controls for held messages and reduce package overhead without changing connection behavior.
**Architecture:** Reuse the existing StateStore and queue receipts. IPC returns a scoped snapshot on demand; the renderer only requests the list while it is open. Keep Electron, its updater, and the dedicated browser.
**Tech Stack:** TypeScript, Electron, native DOM, electron-builder, Node test runner.
**Spec:** `docs/superpowers/specs/2026-10-25-backlog-recovery-design.md`

## Global Constraints

- Keep the default 600000 ms backlog window, account bindings, browser identity, pause choice, and receipt IDs.
- Restore resets the wait clock; clearing never deletes WeChat or dot chat history.
- No additional runtime dependency, service, personal path, account ID or credential.
- Publish Mac ARM, Mac Intel, Windows and update README.

## Review Focus

- Partially delivered replies resume at their saved part with the same idempotency key (task 1).
- A restored uncertain question is reconciled before any new submit (task 1).
- Account changes and arrivals while the list is open cannot affect a different snapshot (tasks 1 and 2).
- Restored unfinished replies wait for full content; retained attachments survive cleanup (task 1).
- Clear and restart cannot resurrect held messages; a large list preserves selection/scroll during background status updates (tasks 1 and 2).

### Task 1: Durable recovery and lightweight queue work

**Files:** `src/backlog.ts`, `src/types.ts`, `src/state.ts`, `src/queue.ts`, `src/bridge.ts`, `tests/backlog-recovery.test.ts`.
**Interfaces:** `backlogSnapshot(state): BacklogSnapshot`; `manageBacklog(store, action: 'restore' | 'clear', selection: BacklogSelection, now?): Promise<number>`; `Bridge.manageBacklog(action, selection)` publishes the current count. Snapshot contains a connection key and entries with direction, receipt key, preview and timestamp.

- [ ] Add failing integration tests using real StateStore for persisted selection, idempotency, uncertain sends, partial replies, completed refresh, retained media, clear/restart, account scope and no-op polls.
- [ ] Run `node --import tsx --test tests/backlog-recovery.test.ts`; verify meaningful failures.
- [ ] Implement scoped restore/clear on existing records, renew expiration time, preserve receipts and partial position. Make pending refresh and retained-file cleanup work for restored records. Derive the count from durable state.
- [ ] Run `npm test`; all existing and new tests pass. Commit.

### Task 2: Compact list and controls

**Files:** `src/main.ts`, `src/preload.ts`, `src/ui/app.ts`, `src/ui/backlog.ts`, `src/ui/index.html`, `src/ui/style.css`, `tests/backlog-ui.mjs`, `.github/workflows/build.yml`.
**Interfaces:** renderer `backlog(): Promise<BacklogSnapshot>` and `manageBacklog(action, selection)` via window-scoped IPC. List open state and selected receipt keys remain in renderer only.

- [ ] Add a failing desktop fixture: open held list, restore one and selected entries, clear remaining, observe hidden count after restart, leave pause state unchanged, check long text/layout and HTML escaping.
- [ ] Build and run `node tests/backlog-ui.mjs`; confirm missing UI fails.
- [ ] Implement the small main entry and single-window list, snapshot actions, empty state and feedback. Preserve focus/scroll/selection on status updates.
- [ ] Run the desktop fixture and existing smoke/default-browser tests; inspect light/dark screenshots. Commit.

### Task 3: Package and publish

**Files:** `package.json`, `package-lock.json`, `scripts/build.mjs`, `README.md`, `docs/development.md`, `docs/testing.md`, existing build workflow.

- [ ] Retain Electron locales `en`, `en-US`, `zh-CN`, `zh-TW`; minify bundled application code and exclude source screenshots/design assets from the app package. Version 1.1.0.
- [ ] Run `npm run check`, package, smoke, the held-list fixture, default-browser media fixture and updater checks. Compare package file sizes and required resources with 1.0.4.
- [ ] Obtain a fresh code review, address important findings with regression tests, update concise README and validation record.
- [ ] Publish the tagged release; wait for all three jobs, read back all 13 assets and feeds. Preserve local account/pause/queue state when installing the matching Mac artifact. Record results and link release.
