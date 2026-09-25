import { expect } from '@std/expect'

const homepage = await Deno.readTextFile(new URL('../public/home.html', import.meta.url))
const homepageText = homepage.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

Deno.test('marketing homepage keeps its approved structure and destinations', () => {
  for (const section of ['top', 'workings', 'evidence-anatomy', 'run', 'contribute']) {
    expect(homepage).toContain(`id="${section}"`)
  }

  expect(homepageText).toContain('Put your organisation’s')
  expect(homepage).toContain('viewport-fit=cover')
  expect(homepage).toContain('env(safe-area-inset-top)')
  expect(homepage).toContain('Be a part of')
  expect(homepage).toContain('href="https://demo.corpuskit.org"')
  expect(homepage).toContain('href="https://github.com/noicework/corpuskit"')
  expect(homepage).toContain('href="https://noice.net.au"')
  expect(homepage).toContain('href="https://www.progress.com/agentic-rag"')
})

Deno.test('shell and marketing pages take canonical and share URLs from the runtime domain', async () => {
  for (const file of ['../index.html', '../public/home.html', '../public/about.html']) {
    const html = await Deno.readTextFile(new URL(file, import.meta.url))
    const tags = html.match(
      /<(?:link rel="canonical"|meta (?:property|name)="(?:og:url|og:image|twitter:image)")[^>]*>/g,
    ) ?? []
    expect(tags.length).toBeGreaterThan(0)
    for (const tag of tags) expect(tag).toContain('https://__CORPUSKIT_PLATFORM_DOMAIN__/')
  }
})
