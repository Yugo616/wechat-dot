window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== location.origin || event.data?.source !== 'wechat-dot-network') return;
  void chrome.runtime.sendMessage({ type: 'network', method: event.data.method, params: event.data.params }).catch(() => {});
});
