import { expect } from '@std/expect'
import { getPlatformDomain, isPlatformHostname } from './platform-domain.ts'

Deno.test('platform domains default only when absent and normalise DNS names', () => {
  expect(getPlatformDomain()).toBe('corpuskit.org')
  expect(getPlatformDomain('  Research.Example.org ')).toBe('research.example.org')
})

Deno.test('platform domains reject URL, cookie, HTML and invalid DNS input', () => {
  for (
    const domain of [
      '',
      ' ',
      'localhost',
      '127.0.0.1',
      'https://example.org',
      '.example.org',
      'example.org.',
      '*.example.org',
      'example.org:443',
      'example.org/path',
      'example.org?query',
      'example.org; Secure',
      'example.org\r\nSet-Cookie: x=y',
      'example.org"><script>',
      'bad_label.example.org',
      '-bad.example.org',
      'bad-.example.org',
      'a'.repeat(64) + '.org',
      Array(5).fill('a'.repeat(63)).join('.'),
    ]
  ) expect(() => getPlatformDomain(domain)).toThrow('Invalid PLATFORM_DOMAIN')
})

Deno.test('platform hostname matching requires the exact configured DNS suffix', () => {
  for (const host of ['research.example.org', 'marine.research.example.org']) {
    expect(isPlatformHostname(host, 'research.example.org')).toBe(true)
  }
  for (
    const host of ['corpuskit.org', 'notresearch.example.org', 'research.example.org.evil.test']
  ) {
    expect(isPlatformHostname(host, 'research.example.org')).toBe(false)
  }
  expect(isPlatformHostname('research.example.org', '')).toBe(false)
})
