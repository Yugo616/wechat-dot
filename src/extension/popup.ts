const detail = document.querySelector<HTMLParagraphElement>('#detail')!;
for (const button of document.querySelectorAll<HTMLButtonElement>('button')) {
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const status = await chrome.runtime.sendMessage({ type: button.id });
      detail.textContent = status.error || (status.connected ? '已连接。在 WeChat Dot 中点击「开始连接」。' : '已断开。');
    } catch (e) { detail.textContent = (e as Error).message; }
    finally { button.disabled = false; }
  });
}
void chrome.runtime.sendMessage({ type: 'status' }).then(status => { if (status.connected) detail.textContent = '已连接这台电脑。'; });
