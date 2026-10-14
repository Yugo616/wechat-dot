import type { AppStatus, BridgeTask } from './types';

// Page errors cross the browser boundary as text; match transport failures only.
export function connectionRetry(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if ((error as Error)?.name === 'TimeoutError' || /failed to fetch|fetch failed|networkerror|network request failed|network connection was lost|net::ERR_|HTTP (?:408|429|5\d\d)|(?:request|operation|signal).*timed? ?out|页面(?:响应|加载)超时|浏览器已断开|专用浏览器下载中断/i.test(message)) {
    return '连接暂时中断，正在自动重试。无需操作，不用重新登录。';
  }
}

export function problemText(error: unknown, fallback = '连接未完成，请点击下方按钮重新连接。'): string {
  const message = error instanceof Error ? error.message : String(error);
  return /[\u3400-\u9fff]{2}/u.test(message) ? message : fallback;
}

type RecoveryAction = { name: string; label: string };
export function connectionSummary(s: AppStatus): { title: string; detail: string; attention: boolean; retrying: boolean; action?: RecoveryAction } {
  const attention = (detail: string, action?: RecoveryAction) => ({ title: '需要处理', detail: problemText(detail), attention: true, retrying: false, action });
  if (s.weixin === 'error') return attention(s.weixinDetail, { name: 'recover-weixin', label: '重连微信' });
  if (s.dot === 'error') return attention(s.dotDetail, { name: 'recover-dot', label: '重连 dot' });
  if (s.needsReview) return attention('上一条消息还没有确认送达。请打开 dot 核对，再选择下方的处理方式。', { name: 'show-dot', label: '打开 dot' });
  if (s.problem) {
    if (/会自动重试/.test(s.problem) && s.running) return { title: '正在自动重试', detail: s.problem, attention: false, retrying: true };
    const action = /检查更新/.test(s.problem) ? { name: 'check-update', label: '检查更新' }
      : /重新发送|重新录|改发文字/.test(s.problem) ? undefined
      : /输入框|草稿|请.*(?:打开|完成|处理)|核对/.test(s.problem) ? { name: 'show-dot', label: '打开 dot' }
      : { name: 'recover-dot', label: '重连 dot' };
    return attention(s.problem, action);
  }
  const labels: Record<BridgeTask, string> = { weixinReceive: '微信收取', dotReceive: 'dot 收取', dotSend: '问题发送', textSend: '回复发送', mediaSend: '附件发送' };
  const attempts = Object.entries(s.retries ?? {}).map(([task, retry]) => {
    const seconds = retry.nextRetryAt === undefined ? 0 : Math.max(0, Math.ceil((retry.nextRetryAt - Date.now()) / 1000));
    return `${labels[task as BridgeTask]}：${retry.nextRetryAt === undefined ? `正在第 ${retry.attempt} 次尝试` : seconds ? `第 ${retry.attempt} 次尝试未完成，${seconds} 秒后重试` : `第 ${retry.attempt} 次尝试未完成，正在准备重试`}。`;
  }).join(' ');
  const retry = attempts || s.weixinRetry || s.dotRetry;
  if (s.weixinSendError) return attention((s.running || s.connecting ? '请在手机微信里给机器人发一句话，收到后会自动恢复；过期回复会自动跳过。' : '开始转发后，在手机微信里给机器人发一句话即可继续；过期回复会自动跳过。') + (retry ? ' 连接也在自动重试。' : ''));
  if (retry) return { title: '正在自动重试', detail: attempts ? `${attempts} 无需操作。` : retry, attention: false, retrying: true };
  return { title: s.running ? '正在转发' : s.connecting ? '正在准备' : '转发已暂停', detail: s.connecting ? '正在检查登录，稍候会自动开始转发。' : s.detail, attention: false, retrying: false };
}
