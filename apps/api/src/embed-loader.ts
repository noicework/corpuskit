/** Runs on the embedding site. It sends only focus and close messages, never research data. */
export function embedLoader(options: {
  name: string
  tokens: Record<string, string>
}) {
  const script = document.currentScript as HTMLScriptElement | null
  if (!script) return
  const japanese = (script.dataset.lang ?? document.documentElement.lang).startsWith('ja')
  const label = japanese ? '研究アシスタントを開く' : 'Open research assistant'
  const closeLabel = japanese ? 'アシスタントを閉じる' : 'Close assistant'
  const host = document.createElement('div')
  host.dataset.corpuskitWidget = ''
  host.lang = japanese ? 'ja' : 'en'
  script.after(host)
  const root = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = `
    :host { display:block; max-width:100%; padding:.5rem; background:var(--rp-app); color:var(--rp-ink); border-radius:var(--rp-radius); ${
    Object.entries(options.tokens).map(([key, value]) => `${key}:${value}`).join(';')
  } }
    * { box-sizing:border-box }
    .inline { display:grid; gap:.75rem; min-width:0 }
    button, a { font:inherit; min-height:max(44px,2.75rem); min-width:max(44px,2.75rem); padding:.65rem 1rem;
      border:2px solid var(--rp-primary); border-radius:var(--rp-radius-btn);
      background:var(--rp-primary); color:var(--rp-on-primary); cursor:pointer }
    button:focus-visible, a:focus-visible, iframe:focus-visible {
      outline:3px solid var(--rp-focus); outline-offset:3px }
    dialog { width:min(48rem,calc(100% - 1rem)); max-width:calc(100% - 1rem);
      max-height:calc(100dvh - 1rem); padding:.5rem; border:1px solid var(--rp-field);
      border-radius:var(--rp-radius); background:var(--rp-app); color:var(--rp-ink) }
    dialog::backdrop { background:var(--rp-primary); opacity:.65 }
    .bar { display:flex; justify-content:flex-end; padding-bottom:.5rem }
    iframe { display:block; width:100%; max-width:100%; border:1px solid var(--rp-field);
      border-radius:var(--rp-radius); background:var(--rp-app) }
    dialog iframe { max-height:calc(100dvh - 6rem) }
    a { display:flex; align-items:center; width:fit-content; max-width:100%; overflow-wrap:anywhere }
    @media (prefers-reduced-motion:reduce) { * { animation:none; transition:none } }
  `
  root.append(style)
  const src = new URL(script.src)
  src.pathname = src.pathname.replace(/embed\.js$/, 'embed')
  src.search = ''
  // Without an override, the authorised frame reads the portal's current default itself.
  if (script.dataset.view === 'own' || script.dataset.view === 'federated') {
    src.searchParams.set('view', script.dataset.view)
  }
  if (japanese) src.searchParams.set('lang', 'ja')
  else if (script.dataset.lang === 'en') src.searchParams.set('lang', 'en')
  const requestedHeight = Number.parseInt(script.dataset.height ?? '640', 10)
  const height = Number.isFinite(requestedHeight)
    ? Math.max(240, Math.min(2000, requestedHeight))
    : 640
  const makeFrame = () => {
    const frame = document.createElement('iframe')
    frame.src = src.href
    frame.title = options.name + (japanese ? ' - 研究アシスタント' : ' - research assistant')
    frame.style.height = `${height}px`
    frame.referrerPolicy = 'strict-origin-when-cross-origin'
    return frame
  }
  if (script.dataset.mode === 'inline') {
    const inline = document.createElement('div')
    inline.className = 'inline'
    // A usable destination also remains when a browser or host policy refuses the frame.
    const fallback = document.createElement('a')
    fallback.href = src.href.replace(/\/embed(?=\?|$)/, '/ask')
    fallback.target = '_blank'
    fallback.rel = 'noopener noreferrer'
    fallback.textContent = japanese ? '別のタブで開く' : 'Open in a new tab'
    inline.append(makeFrame(), fallback)
    root.append(inline)
    return
  }
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  button.setAttribute('aria-haspopup', 'dialog')
  button.setAttribute('aria-expanded', 'false')
  const dialog = document.createElement('dialog')
  dialog.setAttribute(
    'aria-label',
    options.name + (japanese ? ' - 研究アシスタント' : ' - research assistant'),
  )
  const bar = document.createElement('div')
  bar.className = 'bar'
  const close = document.createElement('button')
  close.type = 'button'
  close.textContent = closeLabel
  bar.append(close)
  dialog.append(bar)
  root.append(button, dialog)
  let frame: HTMLIFrameElement | undefined
  const focusFrame = () => {
    frame?.focus()
    frame?.contentWindow?.postMessage({ type: 'corpuskit-embed-focus' }, src.origin)
  }
  button.addEventListener('click', () => {
    if (!frame) {
      frame = makeFrame()
      frame.addEventListener('load', focusFrame)
      dialog.append(frame)
    }
    dialog.showModal()
    button.setAttribute('aria-expanded', 'true')
    focusFrame()
  })
  close.addEventListener('click', () => dialog.close())
  dialog.addEventListener('close', () => {
    button.setAttribute('aria-expanded', 'false')
    button.focus()
  })
  globalThis.addEventListener('message', (event) => {
    if (event.origin !== src.origin || event.source !== frame?.contentWindow) return
    if (event.data?.type === 'corpuskit-embed-ready' && dialog.open) focusFrame()
    if (event.data?.type === 'corpuskit-embed-close' && dialog.open) dialog.close()
  })
}
