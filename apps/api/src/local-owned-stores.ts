import { AnswerRecordStore, FileAnswerRecordState } from './answer-record-store.ts'
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
import {
  FeedbackStore,
  InsightsStore,
  InvestigationStore,
  McpKeyStore,
  RoutingLog,
  SessionsStore,
  SourceStore,
  WatchStore,
} from './stores.ts'
import { join } from 'node:path'
import { fileMutation } from './file-mutation.ts'
import { BindingStore } from './bindings.ts'
import { EnrichmentStore } from './enrichments.ts'
import { SuggestionStore } from './interrogate.ts'
import { KgProposalStore } from './kg.ts'
import { FileBrandingStore } from './branding-store.ts'
import { TenantStore } from './tenants.ts'
import { FileLifecycleStore } from './lifecycle-store.ts'

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
  tenantEnv?: Record<string, string | undefined>,
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
      const id = store === 'mcpKeys'
        ? (method === 'add' ? (args[0] as { id: string }).id : args[1])
        : store === 'sessions'
        ? (method === 'put' ? (args[2] as { id: string }).id : args[2])
        : store === 'watches'
        ? (method === 'remove' ? args[2] : method === 'update' ? args[1] : undefined)
        : method === 'updateEvidence' || method === 'removeEvidence'
        ? args[3]
        : ['sources', 'enrichments', 'branding', 'suggestions'].includes(store!)
        ? args[1]
        : store === 'investigations'
        ? args[2]
        : args[0]
      const first = args[0]
      const slug = typeof first === 'string'
        ? first
        : typeof first === 'object' && first !== null && 'tenant' in first
        ? String(first.tenant)
        : undefined
      appendAudit(
        audit,
        createAuditEvent({
          ...context.input,
          action: 'local.mutation',
          scope: declaration.scope === 'platform'
            ? { kind: 'platform' }
            : slug
            ? { kind: 'portal', slug }
            : context.input.scope,
          outcome: 'success',
          target: {
            kind: store!,
            ...(typeof id === 'string' && !id.includes('://') &&
                /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,159}$/.test(id)
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
      if (
        (operation.name === 'tenants.patch' &&
          ['tenant.access.update', 'tenant.configuration.update'].includes(context.input.action)) ||
        (operation.name === 'lifecycle.set' &&
          context.input.action === 'portal.lifecycle.update') ||
        (operation.name === 'tenants.setAlias' && context.input.action === 'portal.alias.set') ||
        (operation.name === 'tenants.removeAlias' && context.input.action === 'portal.alias.remove')
      ) {
        appendAudit(audit, createAuditEvent({ ...context.input, outcome: 'success' }))
      }
    },
  }
  const wrap = <T extends object>(
    name: string,
    store: T,
    files?: (args: unknown[]) => string[],
    checkpoint?: (args: unknown[]) => () => void,
  ): T =>
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
            return operations.run({ name: operation, args }, () => {
              const work = () => value.apply(target, args)
              return files && requests.getStore()
                ? fileMutation(
                  files(args),
                  boundary,
                  work,
                  checkpoint?.(args),
                  operation === 'insights.record' || operation === 'routing.record'
                    ? 'append'
                    : 'replace',
                )
                : work()
            })
          } catch (error) {
            // As on the Durable Object, only a record the audit could not take ends the
            // request's writes. Any other failure left the files as they were (ownedMutation
            // restores them), so the route that asked decides what to answer.
            if (error instanceof AuditWriteError) {
              for (let context = requests.getStore(); context; context = context.parent) {
                context.failure = error
              }
            }
            throw error
          }
        }
      },
    })
  const env = tenantEnv ?? {}
  const segment = (value: unknown) =>
    String(value).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'unknown'
  const files = (name: string, extension = 'json') => (args: unknown[]) => [
    join(dataDir, name, `${segment(args[0])}.${extension}`),
  ]
  const attach = (
    shared: { bindings: BindingStore; sources: SourceStore; enrichments: EnrichmentStore },
  ) => {
    shared.bindings.setMutationBoundary((change, path, write) => {
      if (change.operation === 'bindings.migrate') return write()
      guard()
      return operations.run({ name: change.operation, args: [change.slug] }, () => {
        try {
          return fileMutation([path], boundary, write)
        } catch (error) {
          if (error instanceof AuditWriteError) {
            for (let context = requests.getStore(); context; context = context.parent) {
              context.failure = error
            }
          }
          throw error
        }
      })
    })
    // Keep the very same instances in the HTTP app and scheduler. Capture each wrapped
    // method before installing it so the proxy cannot recurse through the decorated instance.
    const install = <T extends object>(
      name: string,
      store: T,
      checkpoint?: (args: unknown[]) => () => void,
    ) => {
      const proxy = wrap(name, store, files(name), checkpoint)
      const methods = DECLARATIONS.filter((d) =>
        d.kind === 'local' && d.path.startsWith(`${name}.`)
      )
        .map((d) => d.path.split('.')[1]!)
      const wrapped = methods.filter((method) => typeof Reflect.get(store, method) === 'function')
        .map((method) => [method, Reflect.get(proxy, method)] as const)
      for (const [method, value] of wrapped) {
        Object.defineProperty(store, method, { value, configurable: true })
      }
    }
    install('sources', shared.sources)
    install(
      'enrichments',
      shared.enrichments,
      (args) => EnrichmentStore.checkpoint(shared.enrichments, String(args[0])),
    )
  }
  const answerRecordState = new FileAnswerRecordState(dataDir)
  const erasure = wrap('erasure', {
    erase: (_slug: string, work: () => unknown) => {
      const result = work()
      boundary.complete()
      return result
    },
  })
  return {
    localMutations,
    attach,
    erasureTransaction: <T>(slug: string, work: () => T): T => erasure.erase(slug, work) as T,
    answerRecords: wrap(
      'answerRecords',
      new AnswerRecordStore(answerRecordState),
      (args) => answerRecordState.mutationPaths(args),
    ),
    insights: wrap('insights', new InsightsStore(dataDir), files('insights', 'jsonl')),
    feedback: wrap('feedback', new FeedbackStore(dataDir), files('feedback')),
    routing: wrap('routing', new RoutingLog(dataDir), files('routing', 'jsonl')),
    suggestions: wrap('suggestions', new SuggestionStore(dataDir), files('suggestions')),
    kgProposals: wrap(
      'kgProposals',
      new KgProposalStore({
        ...env,
        KG_PROPOSALS_PATH: env.KG_PROPOSALS_PATH ?? join(dataDir, 'kg-proposals.json'),
      }, boundary),
    ),
    branding: wrap(
      'branding',
      new FileBrandingStore(env.BRANDING_PATH ?? join(dataDir, 'branding'), boundary),
    ),
    lifecycle: wrap('lifecycle', new FileLifecycleStore(dataDir, boundary)),
    ...(tenantEnv ? { tenants: wrap('tenants', new TenantStore(tenantEnv, boundary)) } : {}),
    sessions: wrap('sessions', new SessionsStore(dataDir, boundary)),
    watches: wrap('watches', new WatchStore(dataDir, boundary)),
    investigations: wrap('investigations', new InvestigationStore(dataDir, boundary)),
    mcpKeys: wrap('mcpKeys', new McpKeyStore(dataDir, { database, audit }, boundary)),
  }
}
