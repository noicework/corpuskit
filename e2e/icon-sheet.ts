// Render the icon family without the SPA or any external assets.
//
//   deno run <runner permissions> e2e/icon-sheet.ts --out .shots/p0b
//     [--chrome /path/to/chrome]
//
// Requires read access, writes to .shots and the temp directory, localhost network access,
// and permission to run Chrome. No environment or system permissions are needed.
import { type Browser, launch } from '@astral/astral'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as Icons from '../apps/web/src/components/icons.tsx'

const usage = 'Usage: deno run e2e/icon-sheet.ts --out .shots/<name> [--chrome /path/to/chrome]'
const options = {
  out: '.shots/p0b',
  chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
}
for (let i = 0; i < Deno.args.length; i++) {
  const argument = Deno.args[i]
  if (argument === '--help') {
    console.log(usage)
    Deno.exit(0)
  }
  if (argument !== '--out' && argument !== '--chrome') throw new Error(usage)
  const value = Deno.args[++i]
  if (!value || value.startsWith('--')) throw new Error(usage)
  options[argument === '--out' ? 'out' : 'chrome'] = value
}

const directory = options.out.replace(/\/+$/, '')
const sizes: Icons.IconSize[] = ['sm', 'md', 'lg']
const entries = Object.entries(Icons)
  .filter((entry): entry is [string, Icons.IconComponent] => typeof entry[1] === 'function')
  .sort(([a], [b]) => a.localeCompare(b, 'en'))
if (!entries.length) throw new Error('The icon module exports no icon components')

const cards = renderToStaticMarkup(
  createElement(
    'div',
    { className: 'icon-grid' },
    entries.map(([name, Icon]) =>
      createElement(
        'section',
        { className: 'icon-card', key: name, 'aria-labelledby': `icon-${name}` },
        createElement('h2', { id: `icon-${name}` }, name),
        createElement(
          'div',
          { className: 'icon-sizes' },
          sizes.map((size) =>
            createElement(
              'div',
              { className: 'icon-example', key: size },
              createElement('div', { className: 'icon-glyph' }, createElement(Icon, { size })),
              createElement('span', null, size),
            )
          ),
        ),
      )
    ),
  ),
)

function html(scheme: 'light' | 'dark') {
  return `<!doctype html>
<html lang="en-AU" data-scheme="${scheme}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <title>CorpusKit icons - ${scheme}</title>
  <style>
    :root {
      color-scheme: light;
      --rp-app: #f6f7f8;
      --rp-surface: #ffffff;
      --rp-ink: #20242b;
      --rp-ink-2: #535c69;
      --rp-line: #d5dae1;
    }
    :root[data-scheme="dark"] {
      color-scheme: dark;
      --rp-app: #0b111b;
      --rp-surface: #121c29;
      --rp-ink: #e4ecf7;
      --rp-ink-2: #adbbcd;
      --rp-line: #354355;
    }
    * { box-sizing: border-box; }
    html { font-size: 16px; }
    body {
      margin: 0;
      padding: 2rem;
      background: var(--rp-app);
      color: var(--rp-ink);
      font-family: system-ui, sans-serif;
    }
    header { margin-bottom: 1.5rem; }
    h1 { margin: 0; font-size: 1.5rem; font-weight: 650; }
    header p { margin: 0.5rem 0 0; color: var(--rp-ink-2); font-size: 0.875rem; }
    .icon-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 0.75rem; }
    .icon-card { padding: 0.875rem; border: 1px solid var(--rp-line); background: var(--rp-surface); }
    .icon-card h2 { margin: 0; font-size: 0.875rem; font-weight: 600; overflow-wrap: anywhere; }
    .icon-sizes { display: flex; justify-content: space-around; gap: 0.5rem; margin-top: 0.75rem; }
    .icon-example { display: flex; flex-direction: column; align-items: center; gap: 0.375rem; }
    .icon-glyph { display: grid; place-items: center; min-height: 1.5rem; min-width: 1.5rem; }
    .icon-example span { color: var(--rp-ink-2); font-size: 0.75rem; }
    svg { display: block; }
  </style>
</head>
<body>
  <header>
    <h1>CorpusKit icon family</h1>
    <p>${entries.length} icons, ${scheme} scheme. sm: 1rem, md: 1.25rem, lg: 1.5rem. Stroke: 1.75.</p>
  </header>
  <main>${cards}</main>
</body>
</html>`
}

await Deno.mkdir(directory, { recursive: true })
// Supplying the binary and profile explicitly avoids Astral's environment-based cache discovery.
const profile = await Deno.makeTempDir({ prefix: 'corpuskit-icons-' })
let browser: Browser | undefined
const captures = []
try {
  browser = await launch({
    path: options.chrome,
    launchPresets: { hardened: true },
    args: [`--user-data-dir=${profile}`],
  })
  const page = await browser.newPage()
  const celestial = page.unsafelyGetCelestialBindings()
  await celestial.Emulation.setDeviceMetricsOverride({
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  for (const scheme of ['light', 'dark'] as const) {
    const source = html(scheme)
    await Deno.writeTextFile(`${directory}/icons-${scheme}.html`, source)
    await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(source)}`, {
      waitUntil: 'load',
    })
    await page.evaluate(async () => {
      await document.fonts.ready
    })
    const metrics = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      height: Math.ceil(document.documentElement.scrollHeight),
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      iconCount: document.querySelectorAll('svg').length,
    }))
    if (metrics.overflowX || metrics.iconCount !== entries.length * sizes.length) {
      throw new Error(`Incomplete icon sheet: ${JSON.stringify(metrics)}`)
    }
    const file = `icons-${scheme}.png`
    await Deno.writeFile(
      `${directory}/${file}`,
      await page.screenshot({
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: metrics.width, height: metrics.height, scale: 1 },
      }),
    )
    captures.push({ scheme, file, ...metrics })
    console.log(`${directory}/${file}: ${entries.length} icons at ${sizes.join(', ')}`)
  }
  await Deno.writeTextFile(
    `${directory}/manifest.json`,
    JSON.stringify({ icons: entries.map(([name]) => name), sizes, captures }, null, 2) + '\n',
  )
} finally {
  try {
    await browser?.close()
  } finally {
    await Deno.remove(profile, { recursive: true })
  }
}
