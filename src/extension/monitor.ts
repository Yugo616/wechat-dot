import defaults from '../../config/defaults.json';

const original = window.fetch.bind(window);
const post = (method: string, params: any) => window.postMessage({ source: 'wechat-dot-network', method, params }, location.origin);
window.fetch = async (input, init) => {
  if (!location.pathname.startsWith(defaults.dot.conversationPath.split('{threadId}')[0])) return original(input, init);
  const request = input instanceof Request ? input : undefined;
  const url = new URL(request?.url ?? String(input), location.href);
  const method = init?.method ?? request?.method ?? 'GET';
  const prefix = defaults.dot.apiPrefixes.find(p => url.origin === location.origin && url.pathname.startsWith(p + '/'));
  if (!prefix || method.toUpperCase() !== 'POST' || !url.pathname.endsWith('/messages')) return original(input, init);
  const requestId = crypto.randomUUID();
  const headers = Object.fromEntries([...new Headers(init?.headers ?? request?.headers)].filter(([name]) => ['authorization', 'chatgpt-account-id'].includes(name.toLowerCase())));
  const postData = typeof init?.body === 'string' ? init.body : await request?.clone().text();
  post('Network.requestWillBeSent', { requestId, request: { url: url.href, method: 'POST', headers, postData } });
  const result = await original(input, init);
  void result.clone().text().then(body => post('Network.responseData', { requestId, body }));
  return result;
};
