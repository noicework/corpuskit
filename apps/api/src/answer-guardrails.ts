import type {
  AgentAskEvent,
  AskEvent,
  GuardrailAction,
  PortalPrompts,
  TenantConfig,
} from '@research-portal/core'
import type { RetrievalProvider } from '@research-portal/retrieval'
import type { InsightsStoreApi } from './stores.ts'
import type { TenantStoreApi } from './tenants.ts'

/** Per-request snapshots and counters reuse the portal's existing configuration and ask log. */
export function portalAnswerPolicy(
  tenants: Pick<TenantStoreApi, 'promptsFor'>,
  insights: Pick<InsightsStoreApi, 'record'>,
) {
  return (
    config: TenantConfig,
    question: string,
    policyRequestId?: string,
    externalAskRow = false,
  ) =>
    new AnswerGuardrail(tenants.promptsFor(config.slug), (guardrailAction) => {
      insights.record(config.slug, {
        ts: new Date().toISOString(),
        question: question.slice(0, 500),
        answered: false,
        citations: 0,
        durationSec: null,
        answerRelevance: null,
        groundedness: null,
        contextRelevance: null,
        guardrailAction,
        policyRequestId,
        guardrailOnly: externalAskRow ||
          (!!policyRequestId && guardrailAction !== 'question-refused'),
      })
    })
}

const normalise = (text: string) =>
  text.normalize('NFKC').toLowerCase().replace(/\p{Cf}/gu, '').replace(/\s+/gu, ' ').trim()

/** Literal phrases, never regular expressions. Latin phrases match whole words; others substrings. */
export function matchesPolicyPhrase(text: string, phrases: readonly string[]): boolean {
  const haystack = normalise(text)
  return phrases.some((phrase) => {
    const needle = normalise(phrase)
    if (!needle) return false
    let offset = haystack.indexOf(needle)
    while (offset !== -1) {
      if (!/^[a-z0-9 ]+$/i.test(needle)) return true
      const before = haystack.slice(Math.max(0, offset - 2), offset).match(/.$/us)?.[0] ?? ''
      const after = haystack.slice(offset + needle.length, offset + needle.length + 2)
        .match(/^./us)?.[0] ?? ''
      if (!/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after)) return true
      offset = haystack.indexOf(needle, offset + 1)
    }
    return false
  })
}

export function answerLength(text: string): number {
  return [...text].length
}

/** One request's immutable policy snapshot. No shared state between portals or requests. */
export class AnswerGuardrail {
  constructor(
    readonly settings: PortalPrompts,
    readonly record: (action: GuardrailAction) => void,
  ) {}

  private message(refusal: boolean): string {
    const policy = this.settings.guardrails!
    return [refusal ? policy.refusalMessage : policy.withheldMessage, policy.contactLine]
      .filter(Boolean).join('\n\n')
  }

  question(query: string): string | null {
    const policy = this.settings.guardrails
    if (!policy || !matchesPolicyPhrase(query, policy.outOfScope)) return null
    this.record('question-refused')
    return this.message(true)
  }

  answer(text: string, overflow = false): string | null {
    const policy = this.settings.guardrails
    if (!policy) return null
    const action = matchesPolicyPhrase(text, policy.blockedTerms)
      ? 'answer-withheld'
      : overflow || (policy.maxAnswerLength !== null && answerLength(text) > policy.maxAnswerLength)
      ? 'length-withheld'
      : null
    if (!action) return null
    this.record(action)
    return this.message(false)
  }

  get holdsAnswer(): boolean {
    const policy = this.settings.guardrails
    return !!policy && (policy.blockedTerms.length > 0 || policy.maxAnswerLength !== null)
  }
}

/** Ask's trust layer may replace streamed words. Inspect both, release only the final answer. */
export function guardedAskWriter(
  policy: AnswerGuardrail | undefined,
  send: (event: unknown) => Promise<void>,
) {
  const held: Record<string, unknown>[] = []
  let streamed = '', final: string | undefined, size = 0, overflow = false
  return {
    async send(value: unknown) {
      if (!policy?.holdsAnswer) return send(value)
      const event = value as Record<string, unknown>
      if (event.type === 'stage') return send(event)
      size += JSON.stringify(event).length
      if (size > 1_000_000) {
        overflow = true
        if (event.type === 'done') held.push({ type: 'done' })
        return
      }
      if (event.type === 'delta' && typeof event.text === 'string') streamed += event.text
      if (event.type === 'done' && typeof event.text === 'string') final = event.text
      held.push(event)
    },
    async finish() {
      if (!policy?.holdsAnswer) return
      // A broken stream never releases its partial answer.
      if (!held.some((event) => event.type === 'done')) {
        const error = held.find((event) => event.type === 'error')
        if (error) await send(error)
        else await send({ type: 'error', message: 'The answer could not be completed.' })
        return
      }
      const text = final ?? streamed
      const rejected = policy.answer(text, overflow) ??
        (matchesPolicyPhrase(streamed, policy.settings.guardrails!.blockedTerms)
          ? policy.answer(streamed)
          : null)
      if (rejected) {
        await send({ type: 'delta', text: rejected })
        await send({ type: 'done', refused: true, text: rejected })
        return
      }
      for (const event of held) {
        if (event.type === 'delta' || event.type === 'verified') continue
        if (event.type === 'done' && text) await send({ type: 'delta', text })
        await send(event)
      }
    },
  }
}

/** Data-plane callers without Ask's trust-layer writer (MCP and estate source answers). */
export function withPortalAnswerPolicy(
  provider: RetrievalProvider,
  policyFor: (tenant: TenantConfig, query: string) => AnswerGuardrail,
): RetrievalProvider {
  return new Proxy(provider, {
    get(target, name) {
      if (name === 'ask') {
        const ask: RetrievalProvider['ask'] = async function* (tenant, query, opts) {
          const policy = policyFor(tenant, query)
          const refused = policy.question(query)
          if (refused) {
            yield { type: 'delta', text: refused }
            yield { type: 'done', text: refused, refused: true }
            return
          }
          if (!policy.holdsAnswer) {
            yield* target.ask(tenant, query, opts)
            return
          }
          const ready: AskEvent[] = []
          const writer = guardedAskWriter(policy, async (event) => {
            ready.push(event as AskEvent)
          })
          for await (const event of target.ask(tenant, query, opts)) {
            await writer.send(event)
            while (ready.length) yield ready.shift()!
          }
          await writer.finish()
          yield* ready
        }
        return ask
      }
      const value = Reflect.get(target, name, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** Hold the agent's text and reasoning until complete. Never expose a rejected partial answer. */
export async function* guardAgentAnswer(
  policy: AnswerGuardrail,
  query: string,
  run: () => AsyncIterable<AgentAskEvent>,
): AsyncIterable<AgentAskEvent> {
  const refused = policy.question(query)
  if (refused) {
    yield { type: 'agent-start', mode: 'orchestrated', sources: [] }
    yield { type: 'delta', text: refused }
    yield { type: 'done', elapsedMs: 0 }
    return
  }
  if (!policy.holdsAnswer) {
    yield* run()
    return
  }
  const held: AgentAskEvent[] = []
  let text = '', size = 0
  for await (const event of run()) {
    if (event.type === 'agent-start' || event.type === 'agent-step') {
      // Reason fields can carry generated prose too.
      yield event.type === 'agent-step' ? { ...event, reason: undefined } : event
      continue
    }
    size += JSON.stringify(event).length
    if (size > 1_000_000) {
      yield { type: 'delta', text: policy.answer(text, true)! }
      yield { type: 'done', elapsedMs: 0 }
      return
    }
    held.push(event)
    if (event.type === 'delta') text += event.text
  }
  if (!held.some((event) => event.type === 'done')) {
    yield held.find((event) => event.type === 'error') ?? {
      type: 'error',
      code: 'upstream',
      message: 'The answer could not be completed.',
      retryable: true,
    }
    return
  }
  const withheld = policy.answer(text)
  if (withheld) {
    yield { type: 'delta', text: withheld }
    yield held.find((event) => event.type === 'done')!
  } else {
    yield* held
  }
}
