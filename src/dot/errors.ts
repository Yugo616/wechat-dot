export class DotAccessError extends Error {
  constructor(readonly status: 401 | 403) {
    super(status === 401
      ? 'ChatGPT 登录已失效。连接已暂停，请重新登录。'
      : 'ChatGPT 拒绝访问（HTTP 403）。连接已暂停；若页面反复要求验证，请先关闭该窗口。');
    this.name = 'DotAccessError';
  }
}
