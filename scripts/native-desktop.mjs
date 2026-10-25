import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', 'build', ...(process.platform === 'win32' ? ['--no-bundle'] : [])], { stdio: 'inherit' });
child.once('exit', code => process.exit(code ?? 1));
child.once('error', error => { console.error(error); process.exit(1); });
