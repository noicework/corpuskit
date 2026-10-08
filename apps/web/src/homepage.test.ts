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

Deno.test('marketing pages take canonical and share URLs from the runtime domain', async () => {
  for (const file of ['../public/home.html', '../public/about.html']) {
    const html = await Deno.readTextFile(new URL(file, import.meta.url))
    const tags = html.match(
      /<(?:link rel="canonical"|meta (?:property|name)="(?:og:url|og:image|twitter:image)")[^>]*>/g,
    ) ?? []
    expect(tags.length).toBeGreaterThan(0)
    for (const tag of tags) expect(tag).toContain('https://__CORPUSKIT_PLATFORM_DOMAIN__/')
  }
})

Deno.test('the portal shell names its share image on the host that served it', async () => {
  // A portal on its own host (a subdomain or an alias) serves /og/corpuskit.png itself, while the
  // platform apex may be a different application altogether.
  const shell = await Deno.readTextFile(new URL('../index.html', import.meta.url))
  const images = shell.match(/<meta (?:property|name)="(?:og:image|twitter:image)"[^>]*>/g) ?? []
  expect(images).toHaveLength(2)
  for (const tag of images) {
    expect(tag).toContain('content="https://__CORPUSKIT_REQUEST_HOST__/og/corpuskit.png"')
  }
})

const about = await Deno.readTextFile(new URL('../public/about.html', import.meta.url))

/** A page's one JSON-LD block, parsed, and its nodes of one type. */
function structuredData(html: string) {
  const blocks = [
    ...html.matchAll(
      /<script type="application\/ld\+json" id="structured-data">([\s\S]*?)<\/script>/g,
    ),
  ]
  expect(blocks).toHaveLength(1)
  const data = JSON.parse(blocks[0]![1]!)
  expect(data['@context']).toBe('https://schema.org')
  const graph = data['@graph'] as Record<string, unknown>[]
  // Every reference inside the graph points at a node in it.
  const ids = new Set(graph.map((node) => node['@id']))
  for (const [, ref] of JSON.stringify(graph).matchAll(/\{"@id":"([^"]+)"\}/g)) {
    expect(ids.has(ref)).toBe(true)
  }
  return (type: string) => graph.filter((node) => node['@type'] === type)
}

Deno.test('home and About describe the project in JSON-LD that parses', () => {
  for (const html of [homepage, about]) {
    const of = structuredData(html)
    const [project] = of('SoftwareApplication')
    expect(project!.name).toBe('CorpusKit')
    expect(project!.license).toBe('https://www.apache.org/licenses/LICENSE-2.0')
    expect(project!.isAccessibleForFree).toBe(true)
    // No price is claimed for the project, and Noice is named as its maintainer.
    expect('offers' in project!).toBe(false)
    expect(project!.maintainer).toEqual({
      '@id': 'https://__CORPUSKIT_PLATFORM_DOMAIN__/#maintainer',
    })
    expect('author' in project!).toBe(false)
    expect(of('Organization')[0]!.legalName).toBe('Noice Pty Ltd')
    expect(of('WebSite')[0]!.url).toBe('https://__CORPUSKIT_PLATFORM_DOMAIN__/')
  }
  expect(structuredData(homepage)('SoftwareSourceCode')[0]!.codeRepository).toBe(
    'https://github.com/noicework/corpuskit',
  )
})

const DESCRIPTOR = 'CorpusKit, the open source research portal for Progress Agentic RAG'

Deno.test('home and About use one descriptor and tie the project to its other homes', () => {
  for (const html of [homepage, about]) {
    const of = structuredData(html)
    // The repository and the hosted service name the same project; LinkedIn names the maintainer.
    expect(of('SoftwareApplication')[0]!.sameAs).toEqual([
      'https://github.com/noicework/corpuskit',
      'https://corpuskit.cloud/',
    ])
    expect(of('Organization')[0]!.sameAs).toEqual(['https://www.linkedin.com/company/noiceapac/'])
    expect(of('SoftwareApplication')[0]!.description).toMatch(
      /^The open source research portal for Progress Agentic RAG: /,
    )
    // Both pages link the hosted service, in the page and in the footer.
    expect(html.match(/href="https:\/\/corpuskit\.cloud"/g)!.length).toBeGreaterThanOrEqual(2)
    expect(html).not.toMatch(/[\u2013\u2014]/)
  }
  expect(homepage).toContain(`<title>${DESCRIPTOR}</title>`)
  for (const name of ['description', 'og:description', 'twitter:description']) {
    const content = homepage.match(new RegExp(`(?:name|property)="${name}" content="([^"]+)"`))![1]!
    expect(content.startsWith(`${DESCRIPTOR}. `)).toBe(true)
    expect(content.length).toBeLessThanOrEqual(160)
  }
  expect(homepageText).toContain(
    'CorpusKit is the open source research portal for Progress Agentic RAG.',
  )
  expect(about).toContain('CorpusKit is the open source research portal for Progress Agentic RAG.')
})

Deno.test('the marketing pages serve their own fonts, with no third-party stylesheet', async () => {
  for (const html of [homepage, about]) {
    expect(html).not.toMatch(/fonts\.(?:googleapis|gstatic)\.com/)
    const sources = [...html.matchAll(/src: url\("(\/fonts\/[^"]+\.woff2)"\) format\("woff2"\)/g)]
      .map(([, path]) => path!)
    expect(sources.length).toBe(12)
    for (const family of ['Archivo', 'IBM Plex Mono', 'Newsreader', 'Source Sans 3']) {
      expect(html).toContain(`font-family: "${family}";`)
    }
    for (const path of sources) {
      const bytes = await Deno.readFile(new URL(`../public${path}`, import.meta.url))
      // wOF2 signature.
      expect([path, [...bytes.slice(0, 4)]]).toEqual([path, [0x77, 0x4f, 0x46, 0x32]])
    }
    // The two faces the first screen paints with load early.
    for (const preload of ['archivo-normal-latin', 'source-sans-3-normal-latin']) {
      expect(html).toContain(
        `<link rel="preload" href="/fonts/${preload}.woff2" as="font" type="font/woff2" crossorigin>`,
      )
    }
  }
  const licence = await Deno.readTextFile(new URL('../public/fonts/OFL.txt', import.meta.url))
  expect(licence).toContain('SIL OPEN FONT LICENSE Version 1.1')
  for (
    const holder of ['Archivo Project Authors', 'IBM Corp.', 'Newsreader Project Authors', 'Adobe']
  ) {
    expect(licence).toContain(holder)
  }
})

Deno.test('About answers common questions, and marks up exactly the questions it shows', () => {
  const section = about.slice(about.indexOf('<section class="glance" id="faq"'))
  const shown = [
    ...section.slice(0, section.indexOf('</section>')).matchAll(
      /<div class="glance-row">\s*<h3>([^<]+)<\/h3>\s*<div><p>([^<]+)<\/p>/g,
    ),
  ].map(([, question, answer]) => [question, answer])
  expect(shown.length).toBeGreaterThanOrEqual(6)
  const [faq] = structuredData(about)('FAQPage')
  const marked = (faq!.mainEntity as { name: string; acceptedAnswer: { text: string } }[])
    .map((q) => [q.name, q.acceptedAnswer.text])
  expect(marked).toEqual(shown)
  expect(about).toContain('<a href="#faq">Frequently asked questions</a>')
  for (const [question, answer] of shown) {
    expect(`${question} ${answer}`).not.toContain('\u2014')
  }
  // Scans, audio and video depend on the Progress plan, as the documentation says.
  const content = shown.find(([question]) => question === 'What content can a portal take in?')
  expect(content?.[1]).toContain('On a Progress Agentic RAG plan that supports them, scanned pages')
  for (const [, answer] of shown) {
    expect(answer).not.toMatch(/including scanned pages/)
  }
})

Deno.test('each share card is a 1200x630 PNG, and About and the docs use their own', async () => {
  for (const card of ['corpuskit.png', 'corpuskit-about.png', 'corpuskit-docs.png']) {
    const bytes = await Deno.readFile(new URL(`../public/og/${card}`, import.meta.url))
    expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    const view = new DataView(bytes.buffer, bytes.byteOffset)
    expect([card, view.getUint32(16), view.getUint32(20)]).toEqual([card, 1200, 630])
  }
  expect(about).toContain(
    '<meta property="og:image" content="https://__CORPUSKIT_PLATFORM_DOMAIN__/og/corpuskit-about.png">',
  )
  expect(homepage).toContain(
    '<meta property="og:image" content="https://__CORPUSKIT_PLATFORM_DOMAIN__/og/corpuskit.png">',
  )
})
