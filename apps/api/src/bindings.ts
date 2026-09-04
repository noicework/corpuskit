import process from 'node:process'
import type { KnowledgeBoxStatus } from '@research-portal/core'
import { envBindings, type KbBinding, regionalBase } from '@research-portal/retrieval'
import { readJsonSafe, writeJsonAtomic } from './persist.ts'

interface StoredBinding extends KbBinding {
  connectedAt: string
}

/**
 * Resolves each tenant's knowledge box binding. Two tiers:
 * - env bindings (ARAG_KB_<SLUG>[_TOKEN]) are the seeded DEMO boxes
 * - bindings connected by an administrator in the app override them, and are
 *   persisted to a JSON file (BINDINGS_PATH, default ./data/bindings.json)
 * Tokens never leave the server; status reporting carries a truncated KB id only.
 */
export class BindingStore {
  private readonly demo: Record<string, KbBinding>
  private connected: Record<string, StoredBinding> = {}
  private readonly path: string

  constructor(env: Record<string, string | undefined> = process.env) {
    this.demo = envBindings(env)
    this.path = env.BINDINGS_PATH ?? './data/bindings.json'
    this.connected = readJsonSafe<Record<string, StoredBinding>>(this.path, {})
    // Legacy entries stored a bare kbId before bindings became URL-based.
    const zone = env.ARAG_ZONE
    for (const entry of Object.values(this.connected)) {
      const legacy = entry as StoredBinding & { baseUrl?: string }
      if (!legacy.baseUrl && legacy.kbId && zone) {
        legacy.baseUrl = `${regionalBase(zone)}/kb/${legacy.kbId}`
      }
    }
  }

  get(slug: string): KbBinding | undefined {
    return this.connected[slug] ?? this.demo[slug]
  }

  isDemo(slug: string): boolean {
    return !this.connected[slug] && Boolean(this.demo[slug])
  }

  set(slug: string, binding: KbBinding): void {
    this.connected[slug] = { ...binding, connectedAt: new Date().toISOString() }
    this.persist()
  }

  /** Remove a connected binding; the tenant falls back to its demo box (if any). */
  remove(slug: string): void {
    delete this.connected[slug]
    this.persist()
  }

  private persist(): void {
    writeJsonAtomic(this.path, this.connected)
  }

  status(slug: string): KnowledgeBoxStatus {
    const connected = this.connected[slug]
    if (connected) {
      return { slug, status: 'connected', kbId: truncate(displayId(connected)) }
    }
    const demo = this.demo[slug]
    if (demo) return { slug, status: 'demo', kbId: truncate(displayId(demo)) }
    return { slug, status: 'none' }
  }
}

/** Public binding-store contract for alternate durable runtimes. */
export type BindingStoreApi = Pick<BindingStore, keyof BindingStore>

const displayId = (binding: KbBinding) =>
  binding.kbId ?? binding.baseUrl.split('/').pop() ?? binding.baseUrl

const truncate = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…` : id)
