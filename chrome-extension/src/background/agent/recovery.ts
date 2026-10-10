export type FailureClass = 'transient' | 'permission' | 'page_structure' | 'user_intervention' | 'unrecoverable';

export function classifyFailure(error: unknown): FailureClass {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (/timeout|timed out|network|temporar|econn|busy/.test(message)) return 'transient';
  if (/not allowed|permission|forbidden|denied|debugger|canceled_by_user/.test(message)) return 'permission';
  if (/element|selector|not found|no longer available|stale|dom/.test(message)) return 'page_structure';
  if (/approval|sign in|login|credential|user/.test(message)) return 'user_intervention';
  return 'unrecoverable';
}

export function recoveryAdvice(kind: FailureClass): string {
  switch (kind) {
    case 'transient': return '重新读取页面状态后有限重试';
    case 'permission': return '等待用户修复权限或改用允许的页面';
    case 'page_structure': return '重新读取页面元素并选择不同定位策略';
    case 'user_intervention': return '进入 waiting_user 并等待用户处理';
    default: return '停止自动重试并报告明确错误';
  }
}
