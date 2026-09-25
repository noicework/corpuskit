import { expect } from '@std/expect'
import { BindingCipher, BindingCryptoError } from './binding-crypto.ts'

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(17)))
const TOKEN = 'test-only-binding-token-海'

Deno.test('binding cipher uses the specified AES-256-GCM envelope, IV and portal AAD', async () => {
  const cipher = new BindingCipher(KEY)
  const sealed = await cipher.seal('marine', TOKEN)
  expect(sealed).toMatch(/^enc:v1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]+$/)
  expect(sealed).not.toContain(TOKEN)
  const [, , ivText, ciphertextText] = sealed.split(':')
  const decode = (text: string) =>
    Uint8Array.from(
      atob(text.replace(/-/g, '+').replace(/_/g, '/')),
      (character) => character.charCodeAt(0),
    )
  const key = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(32).fill(17),
    'AES-GCM',
    false,
    ['decrypt'],
  )
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: decode(ivText!),
      tagLength: 128,
      additionalData: new TextEncoder().encode('corpuskit-binding-v1:marine'),
    },
    key,
    decode(ciphertextText!),
  )
  expect(new TextDecoder().decode(plaintext)).toBe(TOKEN)
  expect(await cipher.open('marine', sealed)).toBe(TOKEN)
  expect(await cipher.seal('marine', TOKEN)).not.toBe(sealed)
})

Deno.test('binding cipher rejects cross-portal copies, wrong keys and modified ciphertext', async () => {
  const cipher = new BindingCipher(KEY)
  const sealed = await cipher.seal('marine', TOKEN)
  const wrong = new BindingCipher(btoa(String.fromCharCode(...new Uint8Array(32).fill(19))))
  await expect(cipher.open('grains', sealed)).rejects.toThrow('binding_decryption_failed')
  await expect(wrong.open('marine', sealed)).rejects.toThrow('binding_decryption_failed')
  const parts = sealed.split(':')
  for (const part of [2, 3]) {
    const altered = [...parts]
    altered[part] = (parts[part]![0] === 'A' ? 'B' : 'A') + parts[part]!.slice(1)
    await expect(cipher.open('marine', altered.join(':'))).rejects.toThrow(
      'binding_decryption_failed',
    )
  }
})

Deno.test('binding cipher rejects malformed and unknown encrypted formats without plaintext fallback', async () => {
  const cipher = new BindingCipher(KEY)
  for (
    const token of [
      'enc:',
      'enc:v2:a:b',
      'enc:v1:a:b',
      'enc:v1:AAAAAAAAAAAAAAAA:AA',
      'enc:v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==',
      'enc:v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:extra',
      'enc:v1:AAAAAAAAAAAAAAA=:AAAAAAAAAAAAAAAAAAAAAA',
    ]
  ) {
    await expect(cipher.open('marine', token)).rejects.toThrow('binding_decryption_failed')
  }
})

Deno.test('binding cipher accepts legacy plaintext but refuses encrypted reads and sealing without a key', async () => {
  const cipher = new BindingCipher()
  expect(await cipher.open('marine', TOKEN)).toBe(TOKEN)
  await expect(cipher.open('marine', 'enc:v1:anything:anything')).rejects.toThrow(
    'binding_key_missing',
  )
  await expect(cipher.seal('marine', TOKEN)).rejects.toThrow('binding_key_missing')
})

Deno.test('binding keys must be canonical standard base64 encoding exactly 32 bytes', () => {
  const urlOnly = btoa(String.fromCharCode(...new Uint8Array(32).fill(255)))
    .replace(/\//g, '_')
  for (
    const key of [
      'test-only-invalid-key',
      KEY.slice(0, -1),
      ` ${KEY}`,
      `${KEY}\n`,
      urlOnly,
      btoa('a'.repeat(31)),
      btoa('a'.repeat(33)),
      KEY.slice(0, -2) + 'F=',
    ]
  ) {
    expect(() => new BindingCipher(key)).toThrow('binding_key_invalid')
  }
  expect(new BindingCipher(KEY).configured).toBe(true)
  expect(new BindingCipher('').configured).toBe(false)
})

Deno.test('binding crypto errors carry only safe static status and code', async () => {
  const cipher = new BindingCipher(KEY)
  const supplied = `enc:v1:${TOKEN}:${KEY}`
  try {
    await cipher.open('marine', supplied)
    throw new Error('Expected rejection')
  } catch (error) {
    expect(error).toBeInstanceOf(BindingCryptoError)
    expect((error as BindingCryptoError).status).toBe(503)
    const text = String(error) + JSON.stringify(error)
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain(KEY)
    expect(text).not.toContain(supplied)
  }
})
