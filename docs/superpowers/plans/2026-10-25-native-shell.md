# Native shell implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship installers measured in tens of MB while preserving all WeChat Dot behavior.

**Architecture:** Tauri hosts the existing renderer and a bundled Node backend. Extract the current Electron main into a shared controller, preserve dedicated-browser behavior and existing NSIS/Mac updater formats.

**Tech Stack:** TypeScript, Tauri 2, Rust, Node 22, existing electron-builder distribution.

**Spec:** docs/superpowers/specs/2026-10-25-native-shell-design.md

## Global Constraints

- macOS arm64/x64 and Windows x64. No user-installed Node or extension.
- Existing user data directory, product name, app ID, queues, profile and pause state stay compatible.
- No forwarding, restoring or clearing real queued messages during validation.
- Installer size and separate browser disk usage are stated separately.
- Build constants live in configuration; no user-specific paths or identifiers.

## Review Focus

- Parent exit or backend crash must not orphan a forwarder or leave a falsely connected UI.
- An old Electron install must update into and later update the native version, including Windows custom install paths.
- System WebView differences must not hide recovery, clear, exit or update controls.
- Browser login reuse and normal Chrome isolation must survive the host change.
- New and previously paused users must keep their state across install/restart and failed updates.

### Task 1: Shared controller and runtime boundary

**Files:** src/controller.ts, src/runtime.ts, src/main.ts, src/dot/browser.ts, src/dot/extension-browser.ts, tests/controller.test.ts.

**Interfaces:** Controller exposes status, action, backlog, manageBacklog, start and close. DesktopHost supplies directories, version, updater, window/quit/open functions and status publishing. BrowserRuntime supplies directories, fetch and optional embedded-window creation.

- [x] Add a real temporary-state controller test for initialization, restore/clear while paused, exit preference and restart. Run before implementation; expected missing-controller failure.
- [x] Extract existing logic without changing message handling. Run targeted tests, full check and existing desktop fixtures; expected green.
- [x] Commit shared controller.

### Task 2: Native process and window

**Files:** src/native/*, src-tauri/*, scripts/native-build.mjs, scripts/node-runtime.mjs, tests/native-*.

**Interfaces:** JSON-line request/response RPC uses numeric IDs; status/host actions are events. Native UI adapts the same window.wechatDot API. Runtime version and resource paths come from host/config.

- [x] Add subprocess tests for ready status, parallel commands, pause persistence, malformed request and EOF cleanup; expect missing backend/build failures.
- [x] Add native host, bundled Node, renderer adapter, tray and lifecycle. Native build must launch with clean temporary data and no installed Node.
- [x] Run backend/browser fixture and local native window inspection. Verify close/hide, exit prompt, tray reopen and child cleanup. Commit.

### Task 3: Updates, packages and release

**Files:** src/updates/native.ts, scripts/native-package.mjs, .github/workflows/build.yml, package.json, README.md, docs/testing.md.

**Interfaces:** Existing UpdateController and feed names/blocks remain; native updater supplies AppAdapter and Node HTTP executor. electron-builder packages the native prepackaged directory.

- [x] Test full and differential downloads, old/new install compatibility and failed install preserving state. Expected failing before native updater.
- [x] Build all three packages, check clean launch and install/update. Measure installer bytes and verify no Electron framework.
- [x] Review entire change; fix reproduced important findings and run affected checks.
- [x] Update README/validation records, publish all three builds, read back release assets/feeds, then update local app preserving accounts, pause and held counts.
