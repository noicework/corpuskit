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
  expect(homepage).toContain('href="https://opax.corpuskit.org"')
  expect(homepage).toContain('href="https://github.com/noicework/corpuskit"')
  expect(homepage).toContain('href="https://noice.net.au"')
  expect(homepage).toContain('href="https://www.progress.com/agentic-rag"')
})
