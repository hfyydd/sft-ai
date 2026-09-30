// Team-internal build: telemetry removed. The public API is kept as a local
// no-op so call sites (executor, context, background) stay unchanged, and
// categorizeError remains available for local logging.
import { createLogger } from '../log';

const logger = createLogger('Analytics');

export class AnalyticsService {
  private static readonly ERROR_TYPE_CATEGORIES = {
    ChatModelAuthError: 'llm_auth_error',
    ChatModelBadRequestError: 'llm_bad_request_error',
    ChatModelForbiddenError: 'llm_forbidden_error',
    ResponseParseError: 'llm_response_parse_error',
    URLNotAllowedError: 'url_blocked_error',
    RequestCancelledError: 'request_cancelled_error',
    ExtensionConflictError: 'extension_conflict_error',
    InvalidInputError: 'invalid_input_error',
    TimeoutError: 'timeout',
    NetworkError: 'network_error',
    TypeError: 'type_error',
    ReferenceError: 'reference_error',
    SyntaxError: 'syntax_error',
    MaxStepsReachedError: 'max_steps_reached',
    MaxFailuresReachedError: 'max_failures_reached',
  } as const;

  private static readonly MESSAGE_PATTERNS: Array<[RegExp, string]> = [
    [/element not found|no such element/, 'element_not_found'],
    [/timeout|timed out/, 'timeout'],
    [/debugger|detached/, 'debugger_error'],
    [/network|fetch|connection/, 'network_error'],
    [/max steps|maxsteps/, 'max_steps_reached'],
    [/max failures|maxfailures/, 'max_failures_reached'],
    [/navigation|navigate/, 'navigation_error'],
    [/permission|denied|forbidden/, 'permission_denied'],
    [/tab|window/, 'tab_error'],
    [
      /\b(unauthorized|invalid\s*api\s*key|missing\s*api\s*key|api\s*key\s*required|no\s*api\s*key)\b/,
      'llm_config_error',
    ],
  ];

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async init(): Promise<void> {
    logger.debug('Analytics disabled in internal build');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async trackTaskStart(taskId: string): Promise<void> {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async trackTaskComplete(taskId: string): Promise<void> {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async trackTaskFailed(taskId: string, errorCategory: string): Promise<void> {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async trackTaskCancelled(taskId: string): Promise<void> {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async trackDomainVisit(url: string): Promise<void> {}

  categorizeError(error: Error | string): string {
    const matchPatterns = (message: string): string | null => {
      for (const [regex, category] of AnalyticsService.MESSAGE_PATTERNS) {
        if (regex.test(message)) return category;
      }
      return null;
    };

    // PRIORITY 1: Use actual Error object type if available
    if (error instanceof Error) {
      const errorType = error.constructor.name;
      const mapped =
        AnalyticsService.ERROR_TYPE_CATEGORIES[errorType as keyof typeof AnalyticsService.ERROR_TYPE_CATEGORIES];
      if (mapped) return mapped;

      // PRIORITY 2: Check error message for untyped errors
      const message = error.message?.toLowerCase() || '';
      const byMessage = matchPatterns(message);
      if (byMessage) return byMessage;

      // If we have an Error object but can't categorize it, return the constructor name
      return `error_${errorType.toLowerCase()}`;
    }

    // PRIORITY 3: Fallback to string-based categorization (least reliable)
    const message = typeof error === 'string' ? error.toLowerCase() : '';
    const byMessage = matchPatterns(message);
    return byMessage ?? 'unknown_error';
  }

  async updateSettings(): Promise<void> {
    logger.debug('Analytics settings update ignored in internal build');
  }
}

// Singleton instance
export const analytics = new AnalyticsService();
