const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const PREFIX = 'enc:v1:'

export type BindingCryptoCode =
  | 'binding_key_missing'
  | 'binding_key_invalid'
  | 'binding_decryption_failed'
  | 'binding_encryption_failed'
  | 'binding_not_initialized'
  | 'binding_storage_invalid'
  | 'binding_unavailable'

/** Safe to report: never carries a token, key, ciphertext or underlying exception. */
export class BindingCryptoError extends Error {
  readonly status = 503

  constructor(readonly code: BindingCryptoCode) {
    super(code)
    this.name = 'BindingCryptoError'
  }
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function urlEncode(bytes: Uint8Array): string {
  return base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function urlDecode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoding')
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  if (urlEncode(bytes) !== value) throw new Error('Invalid encoding')
  return bytes
}

/** Whether a stored token claims to be sealed; such a value is never used as plaintext. */
export function isSealedBindingToken(token: string): boolean {
  return token.startsWith('enc:')
}

export type BindingKeyState = 'missing' | 'valid' | 'invalid'

/** Classify a `BINDING_KEY` value without keeping or reporting any part of it. */
export function bindingKeyState(secret: string | undefined): BindingKeyState {
  if (secret === undefined || secret === '') return 'missing'
  try {
    new BindingCipher(secret)
    return 'valid'
  } catch {
    return 'invalid'
  }
}

/** AES-GCM authenticates the portal slug as well as the token and ciphertext. */
export class BindingCipher {
  readonly configured: boolean
  private readonly rawKey?: Uint8Array<ArrayBuffer>
  private key?: Promise<CryptoKey>

  constructor(secret?: string) {
    this.configured = secret !== undefined && secret !== ''
    if (!this.configured) return
    try {
      if (!/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(secret!)) throw new Error('Invalid key')
      this.rawKey = Uint8Array.from(atob(secret!), (character) => character.charCodeAt(0))
      if (this.rawKey.length !== 32) {
        throw new Error('Invalid key')
      }
    } catch {
      throw new BindingCryptoError('binding_key_invalid')
    }
  }

  private cryptoKey(): Promise<CryptoKey> {
    if (!this.rawKey) throw new BindingCryptoError('binding_key_missing')
    return this.key ??= crypto.subtle.importKey('raw', this.rawKey, 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ])
  }

  async seal(slug: string, token: string): Promise<string> {
    if (!this.configured) throw new BindingCryptoError('binding_key_missing')
    try {
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const ciphertext = await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv,
          additionalData: encoder.encode(`corpuskit-binding-v1:${slug}`),
          tagLength: 128,
        },
        await this.cryptoKey(),
        encoder.encode(token),
      )
      return `${PREFIX}${urlEncode(iv)}:${urlEncode(new Uint8Array(ciphertext))}`
    } catch {
      throw new BindingCryptoError('binding_encryption_failed')
    }
  }

  async open(slug: string, token: string): Promise<string> {
    if (!isSealedBindingToken(token)) return token
    if (!this.configured) throw new BindingCryptoError('binding_key_missing')
    try {
      const parts = token.split(':')
      if (parts.length !== 4 || !token.startsWith(PREFIX)) throw new Error('Invalid envelope')
      const iv = urlDecode(parts[2]!)
      const ciphertext = urlDecode(parts[3]!)
      if (iv.length !== 12 || ciphertext.length < 16) throw new Error('Invalid envelope')
      const plaintext = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv,
          additionalData: encoder.encode(`corpuskit-binding-v1:${slug}`),
          tagLength: 128,
        },
        await this.cryptoKey(),
        ciphertext,
      )
      return decoder.decode(plaintext)
    } catch {
      throw new BindingCryptoError('binding_decryption_failed')
    }
  }
}
