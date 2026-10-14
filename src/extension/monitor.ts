import { config } from './config';

const original = window.fetch.bind(window);
const post = (method: string, params: any) => window.postMessage({ source: 'wechat-dot-network', method, params }, location.origin);
const postPaths = [config.messagesPath, config.filesPath.replace('{fileId}', '').replace(/\/$/, '')]
  .map(template => new RegExp('^' + template.split(/\{[^}]+\}/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+') + '/?$'));
window.fetch = async (input, init) => {
  if (!location.pathname.startsWith(config.conversationPath.split('{threadId}')[0])) return original(input, init);
  const request = input instanceof Request ? input : undefined;
  const url = new URL(request?.url ?? String(input), location.href);
  const method = init?.method ?? request?.method ?? 'GET';
  const prefix = config.apiPrefixes.find(p => url.origin === location.origin && url.pathname.startsWith(p + '/'));
  if (!prefix || method.toUpperCase() !== 'POST' || !postPaths.some(path => path.test(url.pathname.slice(prefix.length)))) return original(input, init);
  const requestId = crypto.randomUUID();
  const headers = Object.fromEntries([...new Headers(init?.headers ?? request?.headers)].filter(([name]) => ['authorization', 'chatgpt-account-id'].includes(name.toLowerCase())));
  const postData = typeof init?.body === 'string' ? init.body : await request?.clone().text();
  post('Network.requestWillBeSent', { requestId, request: { url: url.href, method: 'POST', headers, postData } });
  let result: Response;
  try { result = await original(input, init); }
  catch (error) { post('Network.loadingFailed', { requestId }); throw error; }
  post('Network.responseReceived', { requestId, response: { status: result.status } });
  void result.clone().text().then(body => post('Network.responseData', { requestId, body }));
  return result;
};
