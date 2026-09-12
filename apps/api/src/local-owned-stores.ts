import { AsyncLocalStorage } from 'node:async_hooks'
import {
  appendAudit,
  type AuditInput,
  type AuditStore,
  AuditWriteError,
  createAuditEvent,
} from './audit.ts'
import type { LocalMutationScope } from './audit-execution.ts'
import { DECLARATIONS } from './permissions.ts'
import type { RbacDatabase } from './rbac-state.ts'
import { InvestigationStore, SessionsStore, WatchStore } from './stores.ts'

interface RequestMutation {
  input: Omit<AuditInput, 'outcome'>
  signal: AbortSignal
  closed: boolean
  failure?: unknown
  parent?: RequestMutation
}

/** One runtime's shared stores, using its existing SQL connection and request audit context. */
export function localOwnedStores(
  dataDir: string,
  database: Pick<RbacDatabase, 'transactionSync'>,
  audit: Pick<AuditStore, 'append'>,
) {
  const requests = new AsyncLocalStorage<RequestMutation>()
  const operations = new AsyncLocalStorage<{ name: string; args: unknown[] }>()
  const guard = () => {
    for (let context = requests.getStore(); context; context = context.parent) {
      context.signal.throwIfAborted()
      if (context.failure) throw context.failure
      if (context.closed) throw new AuditWriteError()
    }
  }
  const localMutations: LocalMutationScope = {
    run(input, signal, work) {
      const context: RequestMutation = {
        input: structuredClone(input),
        signal,
        closed: false,
        parent: requests.getStore(),
      }
      return requests.run(context, async () => {
        try {
          guard()
          const result = await work()
          guard()
          return result
        } finally {
          context.closed = true
        }
      })
    },
  }
  const boundary = {
    database,
    complete() {
      const context = requests.getStore()
      // Scheduler calls already have their existing internal system audit boundary.
      if (!context) return
      guard()
      const operation = operations.getStore()
      const declaration = DECLARATIONS.find((d) => d.kind === 'local' && d.path === operation?.name)
      if (!operation || !declaration) throw new AuditWriteError()
      const [store, method] = operation.name.split('.')
      const args = operation.args
      const id = store === 'sessions'
        ? (method === 'put' ? (args[2] as { id: string }).id : args[2])
        : store === 'watches'
        ? (method === 'remove' ? args[2] : method === 'update' ? args[1] : undefined)
        : method === 'updateEvidence' || method === 'removeEvidence'
        ? args[3]
        : args[2]
      appendAudit(
        audit,
        createAuditEvent({
          ...context.input,
          action: 'local.mutation',
          outcome: 'success',
          target: {
            kind: store!,
            ...(typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,159}$/.test(id)
              ? { id }
              : {}),
          },
          detail: {
            ...(context.input.detail as Record<string, unknown>),
            permission: declaration.permission,
            mutation: operation.name,
          },
        }),
      )
    },
  }
  const wrap = <T extends object>(name: string, store: T): T =>
    new Proxy(store, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver)
        if (typeof value !== 'function') return value
        const operation = `${name}.${String(property)}`
        if (!DECLARATIONS.some((d) => d.kind === 'local' && d.path === operation)) {
          return value.bind(target)
        }
        return (...args: unknown[]) => {
          guard()
          try {
            return operations.run({ name: operation, args }, () => value.apply(target, args))
          } catch (error) {
            for (let context = requests.getStore(); context; context = context.parent) {
              context
                .failure = error
            }
            throw error
          }
        }
      },
    })
  return {
    localMutations,
    sessions: wrap('sessions', new SessionsStore(dataDir, boundary)),
    watches: wrap('watches', new WatchStore(dataDir, boundary)),
    investigations: wrap('investigations', new InvestigationStore(dataDir, boundary)),
  }
}
