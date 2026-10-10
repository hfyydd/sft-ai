export type ActionRisk = 'read' | 'navigate' | 'interaction' | 'write' | 'destructive' | 'financial';

const FINANCIAL_RE = /(支付|付款|购买|下单|充值|结算|转账|payment|purchase|checkout|buy|transfer)/i;
const DESTRUCTIVE_RE = /(删除|移除|注销|关闭账号|永久删除|delete|remove|unsubscribe|cancel subscription)/i;
const WRITE_RE = /(提交|发送|发布|保存|上传|下载|授权|确认|提交表单|submit|send|publish|save|upload|download|authorize|confirm)/i;
const SENSITIVE_FIELD_RE = /(password|passwd|secret|token|api[_-]?key|authorization|cookie|cvv|cvc|card[_-]?number|credit[_-]?card|bank[_-]?account|security[_-]?code|social[_-]?security|national[_-]?id|身份证|证件号码|银行卡号|信用卡号|银行账号|验证码|密码|安全码)/i;

export function classifyActionRisk(toolName: string, args: unknown, elementText = ''): ActionRisk {
  const raw = [toolName, JSON.stringify(args), elementText].join(' ');
  if (FINANCIAL_RE.test(raw)) return 'financial';
  if (DESTRUCTIVE_RE.test(raw) || toolName === 'close_tab') return 'destructive';
  if (WRITE_RE.test(raw)) return 'write';
  if (/^(read_page|read_evidence|cache_content|wait|scroll_to_percent|scroll_to_top|scroll_to_bottom|previous_page|next_page|scroll_to_text|get_dropdown_options|done)$/.test(toolName)) return 'read';
  if (/^(go_to_url|open_tab|switch_tab|go_back|search_google)$/.test(toolName)) return 'navigate';
  if (/^(click_element|input_text|select_dropdown_option|send_keys|fill_form|ask_user)$/.test(toolName)) return 'interaction';
  return 'write';
}

export function requiresApproval(toolName: string, args: unknown, elementText = ''): boolean {
  if (
    (toolName === 'input_text' || toolName === 'select_dropdown_option' || toolName === 'fill_form') &&
    SENSITIVE_FIELD_RE.test(elementText)
  ) return true;
  const risk = classifyActionRisk(toolName, args, elementText);
  return risk === 'write' || risk === 'destructive' || risk === 'financial';
}

export interface ApprovalContext {
  runId: string;
  toolName: string;
  parameterHash: string;
  tabId?: number;
  url?: string;
  targetUrl?: string;
  expiresAt: number;
}

export function approvalMatchesContext(
  approved: ApprovalContext,
  candidate: ApprovalContext,
  now = Date.now(),
): boolean {
  return (
    approved.runId === candidate.runId &&
    approved.toolName === candidate.toolName &&
    approved.parameterHash === candidate.parameterHash &&
    approved.tabId === candidate.tabId &&
    (approved.url || '') === (candidate.url || '') &&
    (approved.targetUrl || '') === (candidate.targetUrl || '') &&
    approved.expiresAt >= now
  );
}
