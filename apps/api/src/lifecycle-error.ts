/** Safe, structured hosting denials shared by HTTP, MCP and background operations. */
export class PortalLifecycleError extends Error {
  constructor(
    readonly status: 403 | 413 | 423 | 429 | 503,
    readonly body: { error: string; [key: string]: unknown },
  ) {
    super(body.error)
    this.name = 'PortalLifecycleError'
  }
}
