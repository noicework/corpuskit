/**
 * Renders the corpuskit.org share cards and app icons to PNG with headless
 * Chromium (via @astral/astral, already in the import map for the e2e suite).
 *
 *   deno task og:render                # OG images + icons into apps/web/public
 *   deno task og:render --posts <dir>  # also the LinkedIn post cards, into <dir>
 *
 * Fonts come from Google Fonts, so the run needs network access. Each card
 * waits for `document.fonts.ready` before capture so no fallback face leaks
 * into an image.
 */
import { type Browser, launch } from '@astral/astral'
import { type Card, OG_CARDS, POST_CARDS } from './cards.ts'

const PUBLIC_DIR = new URL('../../public/', import.meta.url)

function outputDir(): { ogDir: URL; postsDir: URL | null } {
  const at = Deno.args.indexOf('--posts')
  if (at === -1) return { ogDir: PUBLIC_DIR, postsDir: null }
  const target = Deno.args[at + 1]
  if (!target) {
    console.error('usage: render.ts [--posts <directory>]')
    Deno.exit(2)
  }
  return {
    ogDir: PUBLIC_DIR,
    postsDir: new URL(`${target.replace(/\/?$/, '/')}`, `file://${Deno.cwd()}/`),
  }
}

async function renderCard(browser: Browser, card: Card, dir: URL, stage: string) {
  const source = new URL(`${card.file}.html`, `file://${stage}/`)
  await Deno.mkdir(new URL('.', source), { recursive: true })
  await Deno.writeTextFile(source, card.html)

  const page = await browser.newPage()
  await page.setViewportSize({ width: card.width, height: card.height })
  await page.goto(source.href, { waitUntil: 'networkidle0' })
  const { fonts, overflow } = await page.evaluate(async () => {
    await document.fonts.ready
    const root = document.documentElement
    return {
      fonts: Array.from(document.fonts).filter((f) => f.status === 'loaded').map((f) => f.family),
      overflow: Math.max(
        root.scrollHeight - root.clientHeight,
        root.scrollWidth - root.clientWidth,
      ),
    }
  })
  for (const family of card.fonts) {
    if (!fonts.includes(family)) throw new Error(`${card.file}: font not loaded: ${family}`)
  }
  if (overflow > 0) throw new Error(`${card.file}: content overflows the canvas by ${overflow}px`)
  const png = await page.screenshot({ format: 'png' })
  const target = new URL(card.file, dir)
  await Deno.mkdir(new URL('.', target), { recursive: true })
  await Deno.writeFile(target, png)
  await page.close()
  console.log(
    `${card.width}x${card.height}  ${
      (png.byteLength / 1024).toFixed(0).padStart(4)
    } KB  ${target.pathname}`,
  )
}

const { ogDir, postsDir } = outputDir()
const stage = await Deno.makeTempDir({ prefix: 'corpuskit-og-' })
const browser = await launch({
  args: ['--force-color-profile=srgb', '--force-device-scale-factor=1', '--hide-scrollbars'],
})
try {
  for (const card of OG_CARDS) await renderCard(browser, card, ogDir, stage)
  if (postsDir) {
    for (const card of POST_CARDS) await renderCard(browser, card, postsDir, stage)
  }
} finally {
  await browser.close()
  await Deno.remove(stage, { recursive: true })
}
