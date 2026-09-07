/**
 * Share-card definitions for corpuskit.org. Each card is a self-contained HTML
 * document in the marketing site's visual system (see apps/web/public/home.html
 * for the source of the palette, type and the highlight-plus-citation motif).
 * `render.ts` screenshots them to PNG.
 */

export interface Card {
  /** Output file name, relative to the chosen output directory. */
  file: string
  width: number
  height: number
  html: string
  /** Web font families the card uses; capture fails if any is not loaded. */
  fonts: string[]
}

const TEXT_FONTS = ['Archivo', 'Source Sans 3', 'IBM Plex Mono']

const GOOGLE_FONTS =
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Newsreader:ital,opsz,wght@0,6..72,300..700;1,6..72,300..700&family=Source+Sans+3:wght@400;600&family=Archivo:wght@600;700&display=block'

/** The same fractal-noise grain that home.html lays over the whole page. */
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.88' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.72'/%3E%3C/svg%3E\")"

const SHELL_CSS = `
  :root {
    --paper: #f2efe7;
    --paper-soft: #f8f6f0;
    --paper-deep: #e6e0d4;
    --ink: #1c1c19;
    --ink-soft: #5c5a53;
    --rule: #cec8bb;
    --blue: #155da6;
    --blue-dark: #0d467f;
    --blue-pale: #dce8f4;
    --white: #fffdf8;
    --serif: "Newsreader", Georgia, serif;
    --sans: "Source Sans 3", Arial, sans-serif;
    --mono: "IBM Plex Mono", monospace;
    --display: "Archivo", sans-serif;
    --pad: 64px;
    --h1: 94px;
    --lede: 26px;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; overflow: hidden; }
  body {
    position: relative;
    color: var(--ink);
    background: var(--paper);
    font-family: var(--sans);
    -webkit-font-smoothing: antialiased;
  }
  body::before {
    content: "";
    position: absolute;
    inset: 0;
    z-index: 20;
    pointer-events: none;
    opacity: .055;
    background-image: ${GRAIN};
  }
  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    padding: var(--pad);
  }
  .top {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 2rem;
  }
  .brand {
    font-family: var(--display);
    font-size: 40px;
    font-weight: 700;
    line-height: 1;
    letter-spacing: -.055em;
  }
  .brand-mark { color: var(--blue); }
  .top-label {
    color: var(--ink-soft);
    font-family: var(--mono);
    font-size: 17px;
    letter-spacing: .01em;
  }
  .body {
    display: flex;
    flex: 1;
    flex-direction: column;
    justify-content: flex-end;
    min-height: 0;
    margin-top: 36px;
  }
  h1 {
    margin: 0;
    font-family: var(--display);
    font-size: var(--h1);
    font-weight: 600;
    line-height: .92;
    letter-spacing: -.04em;
    text-wrap: nowrap;
  }
  .hl {
    margin-inline: -.04em;
    padding-inline: .08em;
    background-image: linear-gradient(-.7deg, transparent 6%, var(--blue-pale) 8%, var(--blue-pale) 91%, transparent 93%);
    background-repeat: no-repeat;
    background-size: 100% 100%;
    background-position: left center;
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
  }
  .cite {
    display: inline-block;
    margin-left: .32em;
    padding: .1em .4em;
    border: 1px solid rgba(21, 93, 166, .4);
    border-radius: 4px;
    color: var(--blue-dark);
    font-family: var(--mono);
    font-size: .18em;
    font-weight: 500;
    letter-spacing: 0;
    line-height: 1;
    vertical-align: top;
    transform: translateY(.22em);
  }
  .lede {
    max-width: 40em;
    margin: 30px 0 0;
    color: var(--ink-soft);
    font-size: var(--lede);
    line-height: 1.4;
  }
  .lede strong { color: var(--ink); font-weight: 600; }
  .strip {
    display: flex;
    justify-content: space-between;
    gap: 2rem;
    margin-top: 44px;
    padding-top: 18px;
    border-top: 1px solid var(--ink);
    color: var(--ink-soft);
    font-family: var(--mono);
    font-size: 17px;
    line-height: 1.3;
  }
  .strip strong { color: var(--ink); font-weight: 500; }

  /* Answer card (the .question-card / .citation / .confidence motifs). */
  .two-col {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 470px;
    column-gap: 56px;
    align-items: end;
  }
  .answer-card {
    padding: 30px 32px 26px;
    border: 1px solid var(--rule);
    background: var(--white);
    font-size: 18px;
    line-height: 1.5;
  }
  .answer-card .question {
    margin: 0 0 18px;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--rule);
    color: var(--ink-soft);
    font-size: 16px;
  }
  .answer-card p { margin: 0 0 10px; }
  .pill {
    display: inline-grid;
    place-items: center;
    width: 1.3em;
    height: 1.3em;
    margin-left: .2em;
    border-radius: 50%;
    background: var(--blue);
    color: white;
    font-size: .72em;
    font-weight: 600;
    line-height: 1;
    vertical-align: .15em;
  }
  .confidence {
    display: flex;
    align-items: center;
    gap: .7em;
    margin-top: 18px;
    padding-top: 14px;
    border-top: 1px solid var(--rule);
    color: var(--ink-soft);
    font-size: 16px;
  }
  .confidence::before {
    content: "";
    width: 7px;
    height: 7px;
    margin-right: 26px;
    border-radius: 50%;
    background: var(--blue);
    box-shadow: 13px 0 0 var(--blue), 26px 0 0 var(--rule);
  }
  .confidence strong { color: var(--ink); font-weight: 600; }

  /* Passage quote (the .paper-quote motif). */
  .passage {
    max-width: 34em;
    margin: 34px 0 0;
    padding-left: 22px;
    border-left: 3px solid var(--blue);
    color: var(--ink-soft);
    font-family: var(--serif);
    font-size: 25px;
    font-style: italic;
    line-height: 1.35;
  }
  .passage cite {
    display: block;
    margin-top: 10px;
    color: var(--ink-soft);
    font-family: var(--mono);
    font-size: 15px;
    font-style: normal;
  }

  /* Terminal (the .code-card motif from the run section). */
  .code-card {
    margin-top: 36px;
    border: 1px solid rgba(255, 255, 255, .36);
    background: #0f4d89;
    color: white;
    font-family: var(--mono);
    font-size: 21px;
  }
  .code-top {
    display: flex;
    justify-content: space-between;
    padding: 12px 22px;
    border-bottom: 1px solid rgba(255, 255, 255, .25);
    color: var(--blue-pale);
    font-size: 15px;
  }
  .code-card pre { margin: 0; padding: 24px 26px; line-height: 1.9; }
  .code-dim { color: #9fc3e4; }
  .cursor {
    display: inline-block;
    width: .56em;
    height: 1.05em;
    margin-left: .12em;
    background: var(--blue-pale);
    vertical-align: -.14em;
  }

  /* Five views. */
  .views {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 18px;
    margin-top: 40px;
  }
  .view {
    padding-top: 14px;
    border-top: 1px solid var(--ink);
  }
  .view .n {
    display: block;
    color: var(--blue-dark);
    font-family: var(--mono);
    font-size: 15px;
    margin-bottom: 6px;
  }
  .view .t {
    font-family: var(--display);
    font-size: 30px;
    font-weight: 600;
    letter-spacing: -.03em;
    line-height: 1;
  }
  .view .d {
    margin: 8px 0 0;
    color: var(--ink-soft);
    font-size: 16px;
    line-height: 1.35;
  }

  /* App icon. */
  .icon {
    display: grid;
    width: 100%;
    height: 100%;
    place-items: center;
    background: var(--paper);
    font-family: var(--display);
    font-weight: 700;
    letter-spacing: -.08em;
    line-height: 1;
  }
  .icon span { position: relative; z-index: 3; margin-left: -.06em; }
`

function htmlDocument(
  width: number,
  height: number,
  body: string,
  vars: Record<string, string> = {},
): string {
  const custom = Object.entries(vars).map(([k, v]) => `${k}: ${v};`).join(' ')
  return `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="${GOOGLE_FONTS}">
<style>
${SHELL_CSS}
html, body { width: ${width}px; height: ${height}px; }
:root { ${custom} }
</style>
</head>
<body>${body}</body>
</html>`
}

const BRAND = '<div class="brand">CorpusKit<span class="brand-mark">/</span></div>'

function strip(left: string, right = 'corpuskit.org'): string {
  return `<div class="strip"><span>${left}</span><span>${right}</span></div>`
}

const LICENCE_STRIP = strip(
  '<strong>Open source</strong> · Apache 2.0 · corpuskit.org',
  'Maintained by Noice',
)

/**
 * The launch card: the hero headline with its highlight and citation, the
 * descriptor and the licence strip. The OG images carry no top-right label
 * (the wordmark stands alone); the post variant keeps one.
 */
function launch(
  width: number,
  height: number,
  file: string,
  options: { square?: boolean; label?: string } = {},
): Card {
  const vars: Record<string, string> = options.square
    ? { '--h1': '136px', '--lede': '34px', '--pad': '80px' }
    : {}
  const label = options.label ? `<span class="top-label">${options.label}</span>` : ''
  return {
    file,
    width,
    height,
    fonts: TEXT_FONTS,
    html: htmlDocument(
      width,
      height,
      `<div class="card">
        <div class="top">${BRAND}${label}</div>
        <div class="body">
          <h1>Put your<br>organisation’s<br>research <span class="hl">to work</span><span class="cite">1</span></h1>
          <p class="lede">Search collections, ask cited questions and explore connections between sources.</p>
          ${LICENCE_STRIP}
        </div>
      </div>`,
      vars,
    ),
  }
}

/** App icon: the brand initial and mark on paper. */
function icon(size: number, file: string): Card {
  return {
    file,
    width: size,
    height: size,
    fonts: ['Archivo'],
    html: htmlDocument(
      size,
      size,
      `<div class="icon" style="font-size:${
        Math.round(size * 0.66)
      }px"><span>C<span class="brand-mark">/</span></span></div>`,
    ),
  }
}

export const OG_CARDS: Card[] = [
  launch(1200, 630, 'og/corpuskit.png'),
  launch(1200, 1200, 'og/corpuskit-square.png', { square: true }),
  icon(180, 'apple-touch-icon.png'),
  icon(96, 'favicon.png'),
]

const POST_W = 1200
const POST_H = 627

function post(file: string, body: string, vars: Record<string, string> = {}): Card {
  return {
    file,
    width: POST_W,
    height: POST_H,
    fonts: TEXT_FONTS,
    html: htmlDocument(POST_W, POST_H, body, vars),
  }
}

export const POST_CARDS: Card[] = [
  launch(POST_W, POST_H, 'posts/01-launch.png', { label: 'Open source research portal' }),

  post(
    'posts/02-cited-passages.png',
    `<div class="card">
      <div class="top">${BRAND}<span class="top-label">Every answer cited</span></div>
      <div class="body">
        <h1>Answers cite the<br>material they draw on,<br>down to the <span class="hl">passage</span><span class="cite">1</span></h1>
        <div class="passage">Seagrass recovery was slower where winter turbidity remained above the long-term median.
          <cite>1 &nbsp;Estuary condition report · 2023 · page 14</cite>
        </div>
        ${LICENCE_STRIP}
      </div>
    </div>`,
    { '--h1': '80px' },
  ),

  post(
    'posts/03-check-the-answer.png',
    `<div class="card">
      <div class="top">${BRAND}<span class="top-label">Read the source</span></div>
      <div class="body">
        <div class="two-col">
          <h1>Check the<br>answer<br>against the<br><span class="hl">research</span><span class="cite">1</span></h1>
          <div class="answer-card">
            <p class="question">Why did seagrass recover more slowly at some sites?</p>
            <p>Seagrass recovered more slowly at sites where winter turbidity remained above the long-term median.<span class="pill">1</span></p>
            <p>At those sites, light at the canopy fell below the minimum required by <i>Zostera muelleri</i> on 63 per cent of monitored days.<span class="pill">2</span></p>
            <div class="confidence"><strong>High confidence</strong><span>Both claims are directly supported by the cited reports</span></div>
          </div>
        </div>
        ${LICENCE_STRIP}
      </div>
    </div>`,
    { '--h1': '82px' },
  ),

  post(
    'posts/04-five-views.png',
    `<div class="card">
      <div class="top">${BRAND}<span class="top-label">One collection, five ways in</span></div>
      <div class="body">
        <h1>Ask. Search. Library.<br>Map. <span class="hl">Manage.</span><span class="cite">1</span></h1>
        <div class="views">
          <div class="view"><span class="n">01</span><div class="t">Ask</div><p class="d">Cited answers from the collection</p></div>
          <div class="view"><span class="n">02</span><div class="t">Search</div><p class="d">Find the passage, not just the file</p></div>
          <div class="view"><span class="n">03</span><div class="t">Library</div><p class="d">Browse and filter every source</p></div>
          <div class="view"><span class="n">04</span><div class="t">Map</div><p class="d">Explore connections between sources</p></div>
          <div class="view"><span class="n">05</span><div class="t">Manage</div><p class="d">Configure the portal and its corpus</p></div>
        </div>
        ${LICENCE_STRIP}
      </div>
    </div>`,
    { '--h1': '92px' },
  ),

  post(
    'posts/05-open-source.png',
    `<div class="card">
      <div class="top">${BRAND}<span class="top-label">github.com/noicework/corpuskit</span></div>
      <div class="body">
        <h1>Open source under<br>the <span class="hl">Apache 2.0 licence</span><span class="cite">1</span></h1>
        <div class="code-card">
          <div class="code-top"><span>Terminal</span><span>Deno · Cloudflare Workers</span></div>
          <pre><span class="code-dim">$</span> git clone https://github.com/noicework/corpuskit.git<span class="cursor"></span></pre>
        </div>
        ${
      strip(
        '<strong>Open source</strong> · Apache 2.0 · corpuskit.org',
        'Powered by Progress Agentic RAG',
      )
    }
      </div>
    </div>`,
    { '--h1': '86px' },
  ),
]
