import process from 'node:process'
import { readFileSync } from 'node:fs'
import type { KnowledgeBoxStatus } from '@research-portal/core'
import { envBindings, type KbBinding, regionalBase } from '@research-portal/retrieval'
import { writeJsonAtomic } from './persist.ts'
import { BindingCipher, BindingCryptoError } from './binding-crypto.ts'

export interface StoredBinding extends KbBinding {
  connectedAt: string
}
export type BindingRecords = Record<string, StoredBinding>
export interface BindingEncryptionStatus {
  configured: boolean
  required: boolean
  writable: boolean
}

/** Reject malformed credential records without echoing their contents. */
export function bindingRecords(value: unknown, zone?: string): BindingRecords {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BindingCryptoError('binding_storage_invalid')
  }
  const records: BindingRecords = {}
  for (const [slug, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== 'object' || typeof entry.token !== 'string') {
      throw new BindingCryptoError('binding_storage_invalid')
    }
    const baseUrl = typeof entry.baseUrl === 'string'
      ? entry.baseUrl
      : typeof entry.kbId === 'string' && zone
      ? `${regionalBase(zone)}/kb/${entry.kbId}`
      : undefined
    if (!baseUrl) throw new BindingCryptoError('binding_storage_invalid')
    Object.defineProperty(records, slug, {
      value: { ...entry, baseUrl },
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  return records
}

export function ownBinding(
  records: Record<string, KbBinding>,
  slug: string,
): KbBinding | undefined {
  return Object.hasOwn(records, slug) ? records[slug] : undefined
}

/** Decode the complete snapshot before committing any migration or exposing its credentials. */
export async function prepareBindings(records: BindingRecords, cipher: BindingCipher): Promise<{
  stored: BindingRecords
  connected: BindingRecords
  changed: boolean
}> {
  const stored: BindingRecords = {}
  const connected: BindingRecords = {}
  let changed = false
  for (const [slug, entry] of Object.entries(records)) {
    const token = await cipher.open(slug, entry.token)
    Object.defineProperty(connected, slug, {
      value: { ...entry, token },
      enumerable: true,
      configurable: true,
      writable: true,
    })
    const seal = cipher.configured && !entry.token.startsWith('enc:')
    changed ||= seal
    Object.defineProperty(stored, slug, {
      value: { ...entry, token: seal ? await cipher.seal(slug, token) : entry.token },
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  return { stored, connected, changed }
}

/** File-backed server-only credentials; encrypted deployments initialize before serving requests. */
export class BindingStore {
  private readonly demo: Record<string, KbBinding>
  private connected: BindingRecords = {}
  private stored: BindingRecords
  private readonly path: string
  private readonly cipher: BindingCipher
  private initialized: boolean
  private initialization?: Promise<void>

  constructor(env: Record<string, string | undefined> = process.env) {
    this.demo = envBindings(env)
    this.path = env.BINDINGS_PATH ?? './data/bindings.json'
    this.cipher = new BindingCipher(env.BINDING_KEY)
    let value: unknown = {}
    try {
      value = JSON.parse(readFileSync(this.path, 'utf8'))
    } catch (error) {
      if (!(error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT')) {
        throw new BindingCryptoError('binding_storage_invalid')
      }
    }
    this.stored = bindingRecords(value, env.ARAG_ZONE)
    this.initialized = !this.cipher.configured &&
      Object.values(this.stored).every((entry) => !entry.token.startsWith('enc:'))
    if (this.initialized) this.connected = structuredClone(this.stored)
    if (!this.cipher.configured) {
      console.warn(
        '[bindings] BINDING_KEY is missing; local binding credentials use plaintext storage',
      )
    }
  }

  initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve()
    return this.initialization ??= this.initializeBindings()
  }

  private async initializeBindings(): Promise<void> {
    const prepared = await prepareBindings(this.stored, this.cipher)
    if (prepared.changed) writeJsonAtomic(this.path, prepared.stored)
    this.stored = prepared.stored
    this.connected = prepared.connected
    this.initialized = true
  }

  encryptionStatus(): BindingEncryptionStatus {
    return { configured: this.cipher.configured, required: false, writable: true }
  }

  assertWritable(): void {
    this.assertInitialized()
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new BindingCryptoError('binding_not_initialized')
  }

  get(slug: string): KbBinding | undefined {
    this.assertInitialized()
    const binding = ownBinding(this.connected, slug) ?? ownBinding(this.demo, slug)
    return binding ? { ...binding } : undefined
  }

  isDemo(slug: string): boolean {
    this.assertInitialized()
    return !ownBinding(this.connected, slug) && Boolean(ownBinding(this.demo, slug))
  }

  set(slug: string, binding: KbBinding): void | Promise<void> {
    this.assertWritable()
    const entry = { ...binding, connectedAt: new Date().toISOString() }
    if (this.cipher.configured) {
      return this.cipher.seal(slug, entry.token).then((token) => this.commit(slug, entry, token))
    }
    this.commit(slug, entry, entry.token)
  }

  private commit(slug: string, entry: StoredBinding, token: string): void {
    const stored = { ...this.stored, [slug]: { ...entry, token } }
    writeJsonAtomic(this.path, stored)
    this.stored = stored
    this.connected = { ...this.connected, [slug]: entry }
  }

  /** Remove a connected binding; the tenant falls back to its environment box, if any. */
  remove(slug: string): void {
    this.assertInitialized()
    const stored = { ...this.stored }
    delete stored[slug]
    writeJsonAtomic(this.path, stored)
    this.stored = stored
    delete this.connected[slug]
  }

  status(slug: string): KnowledgeBoxStatus {
    this.assertInitialized()
    const connected = ownBinding(this.connected, slug)
    if (connected) return { slug, status: 'connected', kbId: truncate(displayId(connected)) }
    const demo = ownBinding(this.demo, slug)
    if (demo) return { slug, status: 'demo', kbId: truncate(displayId(demo)) }
    return { slug, status: 'none' }
  }
}

/** Public binding-store contract for alternate durable runtimes. */
export type BindingStoreApi = Pick<BindingStore, keyof BindingStore>

const displayId = (binding: KbBinding) =>
  binding.kbId ?? binding.baseUrl.split('/').pop() ?? binding.baseUrl
const truncate = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…` : id)
