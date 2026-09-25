import { type DocPage, docPagesByCategory } from '../../../packages/core/src/docs.ts'
import { PLATFORM_DOMAIN_MARKER } from '../../../packages/core/src/platform-domain.ts'
import { escapeHtml as e, headingIds, renderMarkdown } from './docs-markdown.ts'

const groups = docPagesByCategory()
const pages = groups.flatMap((group) => group.pages)
const overview = 'Learn how to find answers, explore a collection and manage your research portal.'
const pageLink = (page: DocPage) => `/docs/${page.id}`

function sidebar(current?: DocPage): string {
  const links =
    `<a class="docs-overview" href="/docs"${current ? '' : ' aria-current="page"'}>Overview</a>` +
    groups.map(({ category, pages }) =>
      `<section><h2>${e(category)}</h2><ul>${
        pages.map((page) =>
          `<li><a href="${pageLink(page)}"${
            page.id === current?.id ? ' aria-current="page"' : ''
          }>${e(page.title)}</a></li>`
        ).join('')
      }</ul></section>`
    ).join('')
  return `<aside class="docs-sidebar"><nav class="docs-desktop-nav" aria-label="Documentation">${links}</nav><details class="docs-mobile-nav"><summary>Browse documentation</summary><nav aria-label="Documentation">${links}</nav></details></aside>`
}

function content(page?: DocPage): string {
  if (!page) {
    return `<div class="docs-categories">${
      groups.map(({ category, pages }) =>
        `<section class="docs-category"><h2>${e(category)}</h2><ul>${
          pages.map((page) =>
            `<li><a href="${pageLink(page)}">${e(page.title)}</a><p>${e(page.summary)}</p></li>`
          ).join('')
        }</ul></section>`
      ).join('')
    }</div>`
  }
  const id = headingIds()
  // Allocate and render together so subheadings also participate in uniqueness.
  const sections = page.sections.map((section) => ({
    heading: section.heading,
    id: id(section.heading),
    html: renderMarkdown(section.body, id),
  }))
  const toc = sections.length < 3
    ? ''
    : `<nav class="docs-toc" aria-label="On this page"><h2>On this page</h2><ul>${
      sections.map((s) => `<li><a href="#${s.id}">${e(s.heading)}</a></li>`).join('')
    }</ul></nav>`
  const index = pages.findIndex((candidate) => candidate.id === page.id)
  const previous = pages[index - 1]
  const next = pages[index + 1]
  return `${toc}<article class="docs-prose" aria-label="${e(page.title)}">${
    sections.map((s) =>
      `<section aria-labelledby="${s.id}"><h2 id="${s.id}">${
        e(s.heading)
      }<a class="heading-anchor" href="#${s.id}" aria-label="Link to ${
        e(s.heading)
      }">#</a></h2>${s.html}</section>`
    ).join('')
  }</article><nav class="docs-pagination" aria-label="Previous and next pages">
    <a href="${previous ? pageLink(previous) : '/docs'}"><span>Previous</span>${
    e(previous?.title ?? 'Documentation overview')
  }</a>
    <a href="${next ? pageLink(next) : '/docs'}"><span>Next</span>${
    e(next?.title ?? 'Documentation overview')
  }</a>
  </nav>`
}

/** Reuse About's marketing shell, including its styles, metadata, nav and footer. */
export function renderDocsPage(template: string, page?: DocPage): string {
  const title = page?.title ?? 'Documentation'
  const description = page?.summary ?? overview
  // The server fills in the deployment's platform domain when it serves the page.
  const canonical = `https://${PLATFORM_DOMAIN_MARKER}${page ? pageLink(page) : '/docs'}`
  const main = `<main id="main" class="section-shell docs-main">
    <section class="intro" aria-labelledby="docs-title">
      ${page ? '<a class="docs-eyebrow" href="/docs">Documentation</a>' : ''}
      <h1 id="docs-title">${e(title)}</h1><div class="intro-copy"><p>${e(description)}</p></div>
    </section>
    <div class="docs-layout">${sidebar(page)}<div class="docs-content">${content(page)}</div></div>
  </main>`
  if ((template.match(/<main\b/g) ?? []).length !== 1 || !template.includes('</main>')) {
    throw new Error('About template must contain exactly one main element')
  }
  return template
    .replace(/<main\b[^>]*>[\s\S]*?<\/main>/, () => main)
    .replace(/<title>[^<]*<\/title>/, () => `<title>${e(title)} - CorpusKit documentation</title>`)
    .replaceAll(
      /(<meta (?:name|property)="(?:description|og:description|twitter:description)" content=")[^"]*/g,
      (_, prefix) => `${prefix}${e(description)}`,
    )
    .replaceAll(
      /(<meta (?:name|property)="(?:og:title|twitter:title)" content=")[^"]*/g,
      (_, prefix) => `${prefix}${e(title)} - CorpusKit documentation`,
    )
    .replace(/(<link rel="canonical" href=")[^"]*/, (_, prefix) => `${prefix}${canonical}`)
    .replace(/(<meta property="og:url" content=")[^"]*/, (_, prefix) => `${prefix}${canonical}`)
    .replaceAll('href="/about" aria-current="page"', 'href="/about"')
    .replaceAll('href="/docs">Docs</a>', 'href="/docs" aria-current="page">Docs</a>')
    .replace('</head>', '<link rel="stylesheet" href="/docs.css">\n</head>')
}

export async function buildDocs(
  output = new URL('../dist/docs/', import.meta.url),
): Promise<number> {
  const template = await Deno.readTextFile(new URL('../public/about.html', import.meta.url))
  const ids = pages.map((page) => page.id)
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id === 'index')
  ) {
    throw new Error('Documentation page IDs must be unique safe slugs, excluding index')
  }
  // Render first so invalid syntax cannot leave a partially generated collection.
  const documents = [
    { name: 'index', html: renderDocsPage(template) },
    ...pages.map((page) => ({ name: page.id, html: renderDocsPage(template, page) })),
  ]
  await Deno.mkdir(output, { recursive: true })
  for await (const entry of Deno.readDir(output)) {
    if (entry.isFile && entry.name.endsWith('.html')) await Deno.remove(new URL(entry.name, output))
  }
  for (const document of documents) {
    await Deno.writeTextFile(new URL(`${document.name}.html`, output), document.html)
  }
  return documents.length
}

if (import.meta.main) console.log(`Built ${await buildDocs()} documentation pages`)
