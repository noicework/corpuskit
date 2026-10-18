import { expect } from '@std/expect'
import { sitemapUrls, submission } from './indexnow.ts'
import { sitemapXml } from '../src/search-files.ts'

Deno.test('the IndexNow submission lists every sitemap page with the key file at the apex', () => {
  const urls = sitemapUrls(sitemapXml('research.example.org'))
  expect(urls[0]).toBe('https://research.example.org/')
  const body = submission('research.example.org', 'abc12345', urls)
  expect(body.host).toBe('research.example.org')
  expect(body.keyLocation).toBe('https://research.example.org/abc12345.txt')
  expect(body.urlList).toEqual(urls)
})

Deno.test('the IndexNow submission refuses a page on another host', () => {
  expect(() =>
    submission('research.example.org', 'abc12345', ['https://marine.research.example.org/'])
  ).toThrow()
})
