/** Hosting failures are policy results, with copy shared by JSON and streamed actions. */
export function hostingErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined
  const record = body as Record<string, unknown>
  switch (record.error) {
    case 'portal_read_only':
      return 'This portal is read-only. You can browse, search and ask questions, but content and settings cannot be changed.'
    case 'portal_suspended':
      return 'This portal is paused. Contact your portal administrator for help.'
    case 'usage_unavailable':
      return "This portal's usage cannot be checked right now, so new content cannot be added. Try again shortly, or contact your portal administrator."
    case 'agents_disabled':
      return 'Agents are disabled for this portal. Contact your portal administrator to enable them.'
    case 'limit_exceeded':
      if (record.limit === 'maxResources') {
        return 'This portal has reached its resource limit. Remove existing content or contact your portal administrator before adding more.'
      }
      if (record.limit === 'maxBytes') {
        return 'This content would exceed the portal storage limit. Choose a smaller file, remove existing content or contact your portal administrator.'
      }
      return 'This content exceeds a portal limit. Contact your portal administrator for help.'
    case 'ask_quota_exceeded': {
      const at = typeof record.resetsAt === 'string' ? Date.parse(record.resetsAt) : NaN
      const reset = Number.isFinite(at)
        ? ` Try again after ${new Date(at).toLocaleString('en-AU', { timeZoneName: 'short' })}.`
        : ' Try again after the daily limit resets.'
      return `This portal has reached its daily question limit.${reset}`
    }
    default:
      return undefined
  }
}

export function errorCode(body: unknown): string | undefined {
  return body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
    ? body.error
    : undefined
}
