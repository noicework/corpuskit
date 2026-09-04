/** Minimal Worker runtime surface used by CorpusKit; Env itself is Wrangler-generated. */
interface WorkerVersionMetadata {
  id: string
  tag: string
}

interface Fetcher {
  fetch(request: Request): Promise<Response>
}

interface DurableObjectSqlCursor<T> {
  one(): T
  toArray(): T[]
}

interface DurableObjectSqlStorage {
  exec<T extends Record<string, ArrayBuffer | string | number | null>>(
    query: string,
    ...bindings: unknown[]
  ): DurableObjectSqlCursor<T>
}

interface DurableObjectState {
  storage: { sql: DurableObjectSqlStorage }
}

interface DurableObjectStub extends Fetcher {}

interface DurableObjectNamespace<T = unknown> {
  getByName(name: string, options?: { locationHint?: string }): DurableObjectStub
}

interface ScheduledController {
  cron: string
  scheduledTime: number
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void
}

interface ExportedHandler<TEnv> {
  fetch?: (request: Request, env: TEnv, ctx: ExecutionContext) => Response | Promise<Response>
  scheduled?: (
    controller: ScheduledController,
    env: TEnv,
    ctx: ExecutionContext,
  ) => void | Promise<void>
}

declare module 'cloudflare:workers' {
  export class DurableObject<TEnv> {
    constructor(ctx: DurableObjectState, env: TEnv)
    fetch(request: Request): Response | Promise<Response>
  }
}
