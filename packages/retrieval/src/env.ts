import { AragProvider } from './providers/arag/index.ts'
import { regionalBase } from './providers/arag/client.ts'
import process from 'node:process'
import type { KbBinding } from './providers/arag/client.ts'

/**
 * Discover demo-tier knowledge box bindings from environment variables:
 *   ARAG_KB_<SLUG>            knowledge box id for tenant <slug>
 *   ARAG_KB_<SLUG>_TOKEN      service-account token for that knowledge box
 * These are the seeded demo boxes; user-connected bindings override them.
 */
export function envBindings(
  env: Record<string, string | undefined> = process.env,
): Record<string, KbBinding> {
  const zone = env.ARAG_ZONE
  const bindings: Record<string, KbBinding> = {}
  if (!zone) return bindings
  for (const [key, value] of Object.entries(env)) {
    const match = key.match(/^ARAG_KB_([A-Z0-9]+)$/)
    if (!match?.[1] || !value) continue
    const slug = match[1].toLowerCase()
    const token = env[`ARAG_KB_${match[1]}_TOKEN`]
    if (token) {
      bindings[slug] = { baseUrl: `${regionalBase(zone)}/kb/${value}`, token, kbId: value }
    }
  }
  return bindings
}

/**
 * Build the live Agentic RAG provider from environment variables only (no
 * runtime-connectable store) - used by scripts and tests. The API server
 * builds its own provider around a BindingStore instead.
 */
export function createProviderFromEnv(env: Record<string, string | undefined> = process.env) {
  const zone = env.ARAG_ZONE
  if (!zone) {
    throw new Error('ARAG_ZONE is not set - copy .env.example to .env and fill it in')
  }
  const bindings = envBindings(env)
  if (Object.keys(bindings).length === 0) {
    throw new Error(
      'No knowledge box bindings found (ARAG_KB_<SLUG> + ARAG_KB_<SLUG>_TOKEN) - run: deno task provision',
    )
  }
  return new AragProvider({ resolveBinding: (slug) => bindings[slug] })
}
