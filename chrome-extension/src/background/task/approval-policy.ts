export type ActionRisk = 'read' | 'navigate' | 'write' | 'destructive' | 'financial';

const FINANCIAL_RE = /(支付|付款|购买|下单|充值|结算|transfer|payment|purchase|checkout|buy)/i;
const DESTRUCTIVE_RE = /(删除|移除|注销|关闭账号|永久|delete|remove|cancel subscription)/i;
const WRITE_RE = /(提交|发送|发布|保存|上传|授权|submit|send|publish|save|upload|authorize)/i;

export function classifyActionRisk(toolName: string, args: unknown, elementText = ''): ActionRisk {
  const raw = [toolName, JSON.stringify(args), elementText].join(' ');
  if (FINANCIAL_RE.test(raw)) return 'financial';
  if (DESTRUCTIVE_RE.test(raw)) return 'destructive';
  if (WRITE_RE.test(raw)) return 'write';
  if (/^(read_page|cache_content|wait|scroll_|previous_page|next_page|get_dropdown_options|done)$/.test(toolName)) return 'read';
  if (/^(go_to_url|open_tab|switch_tab|go_back|search_google)$/.test(toolName)) return 'navigate';
  if (/^(click_element|input_text|select_dropdown_option|send_keys|close_tab)$/.test(toolName)) return 'write';
  return 'write';
}

export function requiresApproval(toolName: string, args: unknown, elementText = ''): boolean {
  const risk = classifyActionRisk(toolName, args, elementText);
  return risk === 'write' || risk === 'destructive' || risk === 'financial';
}
