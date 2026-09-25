/** Plain words for a hosting refusal, for text a person reads, such as a source's last error. */
export function lifecycleMessage(body: { error: string; [key: string]: unknown }): string {
  switch (body.error) {
    case 'portal_read_only':
      return 'This portal is read-only, so no content can be added or changed.'
    case 'portal_suspended':
      return 'This portal is paused, so no content can be added or changed.'
    case 'limit_exceeded':
      return body.limit === 'maxBytes'
        ? 'This portal has reached its storage limit, so no more content can be added.'
        : 'This portal has reached its resource limit, so no more content can be added.'
    case 'usage_unavailable':
      return "This portal's usage could not be checked, so no content was added. Try again later."
    case 'agents_disabled':
      return 'Agents are disabled for this portal.'
    case 'ask_quota_exceeded':
      return 'This portal has reached its daily question limit.'
    default:
      return 'This portal refused the request.'
  }
}

/** Safe, structured hosting denials shared by HTTP, MCP and background operations. */
export class PortalLifecycleError extends Error {
  constructor(
    readonly status: 403 | 413 | 423 | 429 | 503,
    readonly body: { error: string; [key: string]: unknown },
  ) {
    super(lifecycleMessage(body))
    this.name = 'PortalLifecycleError'
  }
}
