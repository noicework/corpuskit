import process from 'node:process'
import { readFileSync } from 'node:fs'
import type { KnowledgeBoxStatus } from '@research-portal/core'
import { envBindings, type KbBinding, regionalBase } from '@research-portal/retrieval'
import { writeJsonAtomic } from './persist.ts'
import {
  BindingCipher,
  BindingCryptoError,
  type BindingKeyState,
  bindingKeyState,
  isSealedBindingToken,
} from './binding-crypto.ts'

export interface StoredBinding extends KbBinding {
  connectedAt: string
}

/** Deployment-wide reasons stored credentials, or new ones, cannot be used. */
export type BindingStoreError =
  | 'binding_key_missing'
  | 'binding_key_invalid'
  | 'binding_storage_invalid'

export interface BindingEncryptionStatus {
  /** A `BINDING_KEY` value is present. It may still be malformed; see `error`. */
  configured: boolean
  /** This runtime refuses to store a new or replaced binding without a working key. */
  required: boolean
  /** A new or replaced binding can be stored now. */
  writable: boolean
  /** Why stored bindings or writes are degraded, when the cause is deployment-wide. */
  error?: BindingStoreError
  /** Stored bindings withheld because they cannot be opened; each reports `unavailable`. */
  unavailable: number
}

export type BindingChange =
  | { operation: 'bindings.set' | 'bindings.remove'; slug: string }
  | { operation: 'bindings.migrate' }

/** Where a binding store keeps its records. Every write replaces the complete record set. */
export interface BindingPersistence {
  /** The stored record set, `undefined` when nothing is stored yet. Throws when unreadable. */
  read(): unknown
  write(records: Record<string, unknown>, change: BindingChange): void
}

export function ownBinding(
  records: Record<string, KbBinding>,
  slug: string,
): KbBinding | undefined {
  return Object.hasOwn(records, slug) ? records[slug] : undefined
}

/** A stored record with a usable shape, or `undefined`. Never echoes the record. */
function storedBinding(value: unknown, zone?: string): StoredBinding | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entry = value as Record<string, unknown>
  if (typeof entry.token !== 'string') return undefined
  const baseUrl = typeof entry.baseUrl === 'string'
    ? entry.baseUrl
    : typeof entry.kbId === 'string' && zone
    ? `${regionalBase(zone)}/kb/${entry.kbId}`
    : undefined
  return baseUrl ? { ...entry, baseUrl } as StoredBinding : undefined
}

function unavailableStatus(slug: string, entry?: StoredBinding): KnowledgeBoxStatus {
  return { slug, status: 'unavailable', ...(entry ? { kbId: truncate(displayId(entry)) } : {}) }
}

/**
 * Server-only knowledge box credentials, sealed at rest when a key is configured.
 *
 * A stored record that cannot be opened (wrong or missing key, corrupt ciphertext or shape)
 * is withheld: it reports `unavailable`, never falls back to an environment binding or to
 * its stored text, and can still be replaced or removed. The rest of the store keeps working.
 */
export class SealedBindingStore {
  private readonly demo: Record<string, KbBinding>
  private readonly keyState: BindingKeyState
  private readonly cipher: BindingCipher
  /** The record set exactly as stored, so a write never drops records it could not read. */
  private stored: Record<string, unknown> = {}
  private storageInvalid = false
  private readonly connected = new Map<string, StoredBinding>()
  private readonly unavailable = new Map<string, KnowledgeBoxStatus>()
  private pendingOpen: [string, StoredBinding][] = []
  private pendingSeal: string[] = []
  private initialized = false
  private initialization?: Promise<void>

  constructor(
    private readonly persistence: BindingPersistence,
    env: Record<string, string | undefined>,
    private readonly required: boolean,
  ) {
    this.demo = envBindings(env)
    this.keyState = bindingKeyState(env.BINDING_KEY)
    this.cipher = new BindingCipher(this.keyState === 'valid' ? env.BINDING_KEY : undefined)
    let value: unknown
    try {
      value = persistence.read() ?? {}
    } catch {
      value = undefined
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      this.storageInvalid = true
    } else {
      this.stored = { ...value as Record<string, unknown> }
      for (const [slug, raw] of Object.entries(this.stored)) {
        const entry = storedBinding(raw, env.ARAG_ZONE)
        if (!entry) this.unavailable.set(slug, unavailableStatus(slug))
        else if (!isSealedBindingToken(entry.token)) {
          this.connected.set(slug, entry)
          if (this.keyState === 'valid') this.pendingSeal.push(slug)
        } else if (this.keyState === 'valid') this.pendingOpen.push([slug, entry])
        else this.unavailable.set(slug, unavailableStatus(slug, entry))
      }
    }
    this.initialized = this.pendingOpen.length === 0 && this.pendingSeal.length === 0
    if (this.initialized) this.reportWithheld()
  }

  /** Open sealed records and seal remaining plaintext ones. Never rejects. */
  initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve()
    return this.initialization ??= this.openStored()
  }

  private async openStored(): Promise<void> {
    for (const [slug, entry] of this.pendingOpen) {
      try {
        this.connected.set(slug, { ...entry, token: await this.cipher.open(slug, entry.token) })
      } catch {
        this.unavailable.set(slug, unavailableStatus(slug, entry))
      }
    }
    this.pendingOpen = []
    await this.sealPlaintext()
    this.initialized = true
    this.reportWithheld()
  }

  /** Say that credentials are withheld, and why, without naming a portal or a secret. */
  private reportWithheld(): void {
    const { error, unavailable } = this.encryptionStatus()
    if (error === 'binding_storage_invalid') {
      console.warn(
        '[bindings] binding_storage_invalid: stored bindings are unreadable and withheld',
      )
    } else if (unavailable > 0) {
      console.warn(
        `[bindings] ${error ?? 'binding_unavailable'}: ${unavailable} stored binding(s) could ` +
          'not be opened and are withheld until the key is fixed or they are replaced or removed',
      )
    }
  }

  /**
   * Seal stored plaintext once every sealed record has opened with this key. A record that
   * did not open suggests the wrong key, so nothing is sealed with it until that is resolved.
   */
  private async sealPlaintext(): Promise<void> {
    const slugs = this.pendingSeal
    this.pendingSeal = []
    if (slugs.length === 0 || this.unavailable.size > 0) return
    try {
      const next = { ...this.stored }
      for (const slug of slugs) {
        const entry = this.connected.get(slug)!
        next[slug] = { ...entry, token: await this.cipher.seal(slug, entry.token) }
      }
      this.commit(next, { operation: 'bindings.migrate' })
    } catch {
      // The records stay readable as before and sealing is retried on the next start.
      console.warn('[bindings] Stored credentials could not be sealed; retrying on next start')
    }
  }

  encryptionStatus(): BindingEncryptionStatus {
    const error: BindingStoreError | undefined = this.storageInvalid
      ? 'binding_storage_invalid'
      : this.keyState === 'invalid'
      ? 'binding_key_invalid'
      : this.keyState === 'missing' && (this.required || this.unavailable.size > 0)
      ? 'binding_key_missing'
      : undefined
    return {
      configured: this.keyState !== 'missing',
      required: this.required,
      writable: this.writeError() === undefined,
      ...(error ? { error } : {}),
      unavailable: this.unavailable.size,
    }
  }

  private writeError(): BindingStoreError | undefined {
    if (this.storageInvalid) return 'binding_storage_invalid'
    if (this.keyState === 'invalid') return 'binding_key_invalid'
    if (this.keyState === 'missing' && this.required) return 'binding_key_missing'
    return undefined
  }

  assertWritable(): void {
    const error = this.writeError()
    if (error) throw new BindingCryptoError(error)
    this.assertInitialized()
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new BindingCryptoError('binding_not_initialized')
  }

  get(slug: string): KbBinding | undefined {
    this.assertInitialized()
    // Unreadable storage may hide any portal's record, so no environment binding stands in.
    if (this.storageInvalid) throw new BindingCryptoError('binding_storage_invalid')
    if (this.unavailable.has(slug)) throw new BindingCryptoError('binding_unavailable')
    const binding = this.connected.get(slug) ?? ownBinding(this.demo, slug)
    return binding ? { ...binding } : undefined
  }

  isDemo(slug: string): boolean {
    this.assertInitialized()
    if (this.storageInvalid || this.unavailable.has(slug)) return false
    return !this.connected.has(slug) && Boolean(ownBinding(this.demo, slug))
  }

  /** Store a new or replacement binding, sealing it when a key is configured. */
  async set(slug: string, binding: KbBinding): Promise<void> {
    this.assertWritable()
    const entry: StoredBinding = { ...binding, connectedAt: new Date().toISOString() }
    const token = this.keyState === 'valid'
      ? await this.cipher.seal(slug, entry.token)
      : entry.token
    // Merge after sealing so concurrent writes each keep the other's record.
    this.commit({ ...this.stored, [slug]: { ...entry, token } }, {
      operation: 'bindings.set',
      slug,
    })
    this.connected.set(slug, entry)
    this.unavailable.delete(slug)
  }

  /** Remove a stored binding, including a withheld one; the environment box then applies. */
  remove(slug: string): void {
    this.assertInitialized()
    if (this.storageInvalid) throw new BindingCryptoError('binding_storage_invalid')
    const next = { ...this.stored }
    delete next[slug]
    this.commit(next, { operation: 'bindings.remove', slug })
    this.connected.delete(slug)
    this.unavailable.delete(slug)
  }

  status(slug: string): KnowledgeBoxStatus {
    this.assertInitialized()
    if (this.storageInvalid) return { slug, status: 'unavailable' }
    const withheld = this.unavailable.get(slug)
    if (withheld) return { ...withheld }
    const connected = this.connected.get(slug)
    if (connected) return { slug, status: 'connected', kbId: truncate(displayId(connected)) }
    const demo = ownBinding(this.demo, slug)
    if (demo) return { slug, status: 'demo', kbId: truncate(displayId(demo)) }
    return { slug, status: 'none' }
  }

  /** Persistence and cache change together: a failed write leaves both as they were. */
  private commit(next: Record<string, unknown>, change: BindingChange): void {
    this.persistence.write(next, change)
    this.stored = next
  }
}

/** File-backed server-only credentials; encrypted deployments initialize before serving requests. */
export class BindingStore extends SealedBindingStore {
  constructor(env: Record<string, string | undefined> = process.env) {
    const path = env.BINDINGS_PATH ?? './data/bindings.json'
    super(
      {
        read: () => {
          try {
            return JSON.parse(readFileSync(path, 'utf8'))
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
            throw new BindingCryptoError('binding_storage_invalid')
          }
        },
        write: (records) => writeJsonAtomic(path, records),
      },
      env,
      false,
    )
    if (!env.BINDING_KEY) {
      console.warn(
        '[bindings] BINDING_KEY is missing; local binding credentials use plaintext storage',
      )
    }
  }
}

/** Public binding-store contract for alternate durable runtimes. */
export type BindingStoreApi = Pick<SealedBindingStore, keyof SealedBindingStore>

const displayId = (binding: KbBinding) =>
  binding.kbId ?? binding.baseUrl.split('/').pop() ?? binding.baseUrl
const truncate = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…` : id)
