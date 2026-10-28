import type { PortalPrompts } from '@research-portal/core'
import type { RetrievalProvider } from '@research-portal/retrieval'

/** Resolve from this portal on each call, including composed answers, on both runtimes. */
export function withPortalInstructions(
  provider: RetrievalProvider,
  settings: (slug: string) => PortalPrompts,
): RetrievalProvider {
  return new Proxy(provider, {
    get(target, name) {
      if (name === 'ask') {
        const ask: RetrievalProvider['ask'] = (tenant, query, opts = {}) =>
          target.ask(tenant, query, {
            ...opts,
            answerInstructions: settings(tenant.slug).ask,
          })
        return ask
      }
      if (name === 'compose' && target.compose) {
        const compose: NonNullable<RetrievalProvider['compose']> = (
          tenant,
          query,
          passages,
          opts,
        ) =>
          target.compose!(tenant, query, passages, {
            ...opts,
            answerInstructions: settings(tenant.slug).ask,
          })
        return compose
      }
      const value = Reflect.get(target, name, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
