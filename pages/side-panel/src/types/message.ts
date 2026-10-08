export const ACTOR_PROFILES = {
  user: {
    name: '我',
    icon: 'icons/user.svg',
    iconBackground: '#4CAF50',
  },
  system: {
    name: '系统',
    icon: 'icons/system.svg',
    iconBackground: '#2196F3',
  },
  planner: {
    name: '思考与规划',
    icon: 'icons/planner.svg',
    iconBackground: '#FF9800',
  },
  navigator: {
    name: '执行动作',
    icon: 'icons/navigator.svg',
    iconBackground: '#40A9FF',
  },
  validator: {
    name: '校验',
    icon: 'icons/validator.svg',
    iconBackground: '#EC407A',
  },
  manager: {
    name: '管理',
    icon: 'icons/manager.svg',
    iconBackground: '#9C27B0',
  },
  evaluator: {
    name: '评估',
    icon: 'icons/evaluator.svg',
    iconBackground: '#795548',
  },
} as const;

export interface RunCommandMessage {
  type: 'get_run_snapshot' | 'subscribe_run' | 'get_run_events' | 'get_run_events_before' | 'get_run_evidence' | 'pause_task' | 'resume_task' | 'cancel_task';
  runId?: string;
  afterSequence?: number;
  beforeSequence?: number;
  limit?: number;
}
export interface ApprovalCommandMessage {
  type: 'approve_action' | 'reject_action';
  runId: string;
  nonce: string;
  parameterHash: string;
}

