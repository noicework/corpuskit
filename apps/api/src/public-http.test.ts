import { expect } from '@std/expect'
import { isPublicAddress, PublicHttpClient, publicHttpUrl } from './public-http.ts'

Deno.test('public URL guard rejects protocols, credentials and non-global address encodings', () => {
  for (
    const url of [
      'file:///etc/passwd',
      'ftp://example.test/file',
      'http://user:secret@example.test',
      'http://localhost/',
      'http://localhost./',
      'http://portal.local/',
      'http://10.0.0.1/',
      'http://127.1/',
      'http://2130706433/',
      'http://0x7f000001/',
      'http://169.254.169.254/',
      'http://172.31.255.254/',
      'http://192.168.1.2/',
      'http://100.64.0.1/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[fc00::1]/',
      'http://[fe80::1]/',
      'http://[64:ff9b::a00:1]/',
      'http://[2002:a00:1::]/',
    ]
  ) expect(() => publicHttpUrl(url), url).toThrow()
  expect(publicHttpUrl('https://example.test/page#section').href).toBe('https://example.test/page')
  expect(isPublicAddress('8.8.8.8')).toBe(true)
  expect(isPublicAddress('2606:4700:4700::1111')).toBe(true)
  expect(isPublicAddress('not-an-address')).toBe(false)
})

Deno.test('DNS guard refuses mixed public/private answers before transport', async () => {
  let requests = 0
  const client = new PublicHttpClient({
    resolve: async () => ['93.184.216.34', '192.168.1.1'],
    fetch: (() => {
      requests++
      throw new Error('must not fetch')
    }) as typeof fetch,
  })
  await expect(client.request('https://example.test/')).rejects.toThrow('public HTTP')
  expect(requests).toBe(0)
})

Deno.test('DNS guard fails closed on an empty answer', async () => {
  const client = new PublicHttpClient({ resolve: async () => [] })
  await expect(client.request('https://example.test/')).rejects.toThrow('public HTTP')
})
