import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('wechatDot', {
  status: () => ipcRenderer.invoke('status'),
  action: (name: string, value?: string) => ipcRenderer.invoke('action', name, value),
  resize: (height: number) => ipcRenderer.send('resize', height),
  onStatus: (callback: (status: unknown) => void) => { ipcRenderer.on('status', (_e, value) => callback(value)); }
});
