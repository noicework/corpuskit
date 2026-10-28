import { afterAll, beforeAll, describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { type Browser, launch, type Page } from '@astral/astral'
import type { Branding } from '@research-portal/core'
import { startTestServer, type TestServer } from './support/test-server.ts'

// The header search's suggestions (a WAI-ARIA 1.2 combobox with a listbox popup) and the hero's
// question chips, driven through the real app against the DoubleProvider. Set SUGGEST_SHOTS to
// a directory to keep screenshots of each state for a visual check.

let browser: Browser
let server: TestServer
let initialBranding: Branding
const SHOTS = Deno.env.get('SUGGEST_SHOTS')

beforeAll(async () => {
  server = startTestServer()
  // The reader's own scheme, so the dark checks can switch to it.
  initialBranding = { ...server.tenants.get('marine')!.branding, colourScheme: 'viewer' }
  server.tenants.patch('marine', { branding: initialBranding })
  browser = await launch()
  if (SHOTS) await Deno.mkdir(SHOTS, { recursive: true })
})

afterAll(async () => {
  await browser.close()
  await server.close()
})

async function settle(page: Page, probe: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (await page.evaluate(probe)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`${what} did not settle in time`)
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await Deno.writeFile(`${SHOTS}/${name}.png`, await page.screenshot())
}

async function openPortal(
  page: Page,
  width: number,
  scheme: 'light' | 'dark' = 'light',
): Promise<void> {
  await page.setViewportSize({ width, height: 900 })
  await page.emulateMediaFeatures([
    { name: 'prefers-color-scheme', value: scheme },
    { name: 'prefers-reduced-motion', value: 'reduce' },
  ])
  await page.goto(`${server.url}/t/marine`)
  await page.evaluate((value) => localStorage.setItem('rp-scheme', value), { args: [scheme] })
  await page.goto(`${server.url}/t/marine`)
  await page.waitForSelector('.rp-pages-hero-chip')
}

/** Clear a field and type into it, as a reader would. */
async function typeInto(page: Page, selector: string, text: string): Promise<void> {
  await page.evaluate((target) => {
    const input = document.querySelector<HTMLInputElement>(target)!
    input.focus()
    input.select()
  }, { args: [selector] })
  await page.keyboard.press('Backspace')
  await page.keyboard.type(text)
}

const listboxOpen = () => document.querySelector('.rp-suggest-panel [role="listbox"]') !== null
const listboxClosed = () => document.querySelector('.rp-suggest-panel [role="listbox"]') === null

/** The listbox's options as the reader sees them, and which one is highlighted. */
function options(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.rp-suggest-panel [role="listbox"] [role="option"]')].map((
      option,
    ) => ({
      id: option.id,
      text: option.textContent ?? '',
      selected: option.getAttribute('aria-selected') === 'true',
    }))
  )
}

function comboState(page: Page, selector: string) {
  return page.evaluate((target) => {
    const input = document.querySelector<HTMLInputElement>(target)!
    return {
      role: input.getAttribute('role'),
      expanded: input.getAttribute('aria-expanded'),
      controls: input.getAttribute('aria-controls'),
      activeDescendant: input.getAttribute('aria-activedescendant'),
      listboxId: document.querySelector('.rp-suggest-panel [role="listbox"]')?.id ?? null,
      value: input.value,
      focused: document.activeElement === input,
    }
  }, { args: [selector] })
}

describe('header search suggestions', () => {
  it('suggests documents and questions, walks them by keyboard and opens the document', async () => {
    const page = await browser.newPage(server.url)
    try {
      await openPortal(page, 1440)
      const before = await comboState(page, '#header-search')
      expect(before.role).toBe('combobox')
      expect(before.expanded).toBe('false')
      expect(before.controls).toBeNull()

      const start = server.requests.length
      await typeInto(page, '#header-search', 'a')
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(await page.evaluate(listboxClosed)).toBe(true)
      await page.keyboard.type('b')
      await settle(page, listboxOpen, 'the suggestion list')
      await settle(
        page,
        () =>
          document.querySelectorAll('.rp-suggest-panel [role="listbox"] [role="option"]').length ===
            5,
        'the matched documents',
      )
      const open = await comboState(page, '#header-search')
      expect(open.expanded).toBe('true')
      expect(open.controls).toBe(open.listboxId)
      expect(open.activeDescendant).toBeNull()
      const rows = await options(page)
      expect(rows.map((row) => row.text)).toEqual([
        'Search for “ab”',
        'Ask “ab”',
        'Abalone stock health in southern watersStock assessment',
        'What does the latest research say about bycatch reduction in longline fisheries?',
        'How are marine heatwaves affecting abalone populations along the southern coast?',
      ])
      // The matched letters are marked, in the document title and in the question.
      expect(
        await page.evaluate(() =>
          [...document.querySelectorAll('.rp-suggest-panel [role="listbox"] [role="option"] mark')]
            .map((mark) => mark.textContent)
        ),
      ).toEqual(['ab', 'ab', 'Ab', 'ab', 'ab'])
      // Grouped under small headings that name each group for assistive technology.
      expect(
        await page.evaluate(() =>
          [...document.querySelectorAll('.rp-suggest-panel [role="listbox"] [role="group"]')].map((
            group,
          ) => document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent)
        ),
      ).toEqual(['Documents', 'Suggested questions'])
      await settle(
        page,
        () =>
          [...document.querySelectorAll('[role="status"]')].some((region) =>
            region.textContent === '5 suggestions'
          ),
        'the result count',
      )
      await shot(page, 'header-open-1440-light')

      await page.keyboard.press('ArrowDown')
      let walked = await options(page)
      let state = await comboState(page, '#header-search')
      expect(state.activeDescendant).toBe(walked[0]!.id)
      expect(walked.map((row) => row.selected)).toEqual([true, false, false, false, false])
      await page.keyboard.press('ArrowUp')
      walked = await options(page)
      expect(walked.map((row) => row.selected)).toEqual([false, false, false, false, true])
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('ArrowDown')
      walked = await options(page)
      state = await comboState(page, '#header-search')
      expect(state.activeDescendant).toBe(walked[2]!.id)
      expect(state.focused).toBe(true)
      // The highlighted row is drawn with a 2px edge in the focus colour.
      expect(
        await page.evaluate((id) => getComputedStyle(document.getElementById(id)!).boxShadow, {
          args: [walked[2]!.id],
        }),
      ).toContain('inset')
      await shot(page, 'header-highlight-1440-light')

      // Typing fetched one title list, and no keystroke reached search or the typeahead.
      const made = server.requests.slice(start).map((request) => request.path)
      expect(made.filter((path) => path.endsWith('/titles')).length).toBe(1)
      expect(made.some((path) => /\/(typeahead|search|suggest)\b/.test(path))).toBe(false)

      await page.keyboard.press('Enter')
      await settle(page, () => location.pathname === '/t/marine/library/res-1', 'the document')
      const after = await comboState(page, '#header-search')
      expect(after.value).toBe('')
      expect(after.expanded).toBe('false')
    } finally {
      await page.close()
    }
  })

  it('announces the count once per pause, closes on Escape, then clears, and Tab leaves', async () => {
    const page = await browser.newPage(server.url)
    try {
      await openPortal(page, 1440)
      // Load the title list first, so the list below settles once rather than again when it lands.
      await typeInto(page, '#header-search', 'ma')
      await settle(page, listboxOpen, 'the suggestion list')
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      await page.evaluate(() => {
        const seen: string[] = []
        ;(globalThis as unknown as { announced: string[] }).announced = seen
        const observer = new MutationObserver(() => {
          for (const region of document.querySelectorAll('[role="status"]')) {
            const text = region.textContent ?? ''
            if (text.includes('suggestion') && seen[seen.length - 1] !== text) seen.push(text)
          }
        })
        observer.observe(document.body, { subtree: true, childList: true, characterData: true })
      })
      await typeInto(page, '#header-search', 'marine')
      await settle(page, listboxOpen, 'the suggestion list')
      await new Promise((resolve) => setTimeout(resolve, 400))
      const announced = await page.evaluate(() =>
        (globalThis as unknown as { announced: string[] }).announced
      )
      // One settled list, one announcement - not one per character typed.
      expect(announced.length).toBe(1)
      expect(announced[0]).toMatch(/^\d+ suggestions$/)
      const rows = await options(page)
      expect(rows.some((row) => row.text.startsWith('Marine sustainability'))).toBe(true)

      await page.keyboard.press('Escape')
      await settle(page, listboxClosed, 'the closed list')
      let state = await comboState(page, '#header-search')
      expect(state.expanded).toBe('false')
      expect(state.controls).toBeNull()
      expect(state.value).toBe('marine')
      await page.keyboard.press('Escape')
      state = await comboState(page, '#header-search')
      expect(state.value).toBe('')
      expect(state.focused).toBe(true)

      await page.keyboard.type('lobster')
      await settle(page, listboxOpen, 'the suggestion list')
      await page.keyboard.press('Tab')
      await settle(page, listboxClosed, 'the list closed by Tab')
      state = await comboState(page, '#header-search')
      expect(state.focused).toBe(false)

      // Enter with nothing highlighted searches for what was typed.
      await typeInto(page, '#header-search', 'lobster')
      await settle(page, listboxOpen, 'the suggestion list')
      await page.keyboard.press('Enter')
      await settle(page, () => location.pathname === '/t/marine/search', 'the search page')
      expect(await page.evaluate(() => new URLSearchParams(location.search).get('q'))).toBe(
        'lobster',
      )
    } finally {
      await page.close()
    }
  })

  it('opens the library on a topic and Ask on a question', async () => {
    const page = await browser.newPage(server.url)
    try {
      await openPortal(page, 1440)
      await typeInto(page, '#header-search', 'stock')
      await settle(
        page,
        () =>
          [...document.querySelectorAll('.rp-suggest-panel [role="option"]')].some((option) =>
            option.textContent === 'Stock assessment'
          ),
        'the topic row',
      )
      const rows = await options(page)
      const topic = rows.findIndex((row) => row.text === 'Stock assessment')
      for (let step = 0; step <= topic; step++) await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Enter')
      await settle(page, () => location.pathname === '/t/marine/library', 'the library')
      expect(await page.evaluate(() => location.search)).toBe('?topic=stock-assessment')
      const checkedTopics = () =>
        page.evaluate(() => [
          ...new Set(
            [...document.querySelectorAll('label.rp-check')]
              .filter((label) => label.querySelector('input:checked'))
              .map((label) => label.querySelector('span')?.textContent),
          ),
        ])
      await settle(
        page,
        () => document.querySelector('label.rp-check input:checked') !== null,
        'the topic filter',
      )
      expect(await checkedTopics()).toEqual(['Stock assessment'])

      // A second topic chosen from the library itself replaces the filter.
      await typeInto(page, '#header-search', 'harvest')
      await settle(
        page,
        () =>
          [...document.querySelectorAll('.rp-suggest-panel [role="option"]')].some((option) =>
            option.textContent === 'Post-harvest and supply chain'
          ),
        'the second topic row',
      )
      const second = (await options(page)).findIndex((row) =>
        row.text === 'Post-harvest and supply chain'
      )
      for (let step = 0; step <= second; step++) await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Enter')
      await settle(page, () => location.search === '?topic=post-harvest', 'the second topic')
      await settle(
        page,
        () =>
          [...document.querySelectorAll('label.rp-check')].some((label) =>
            label.textContent?.startsWith('Post-harvest') && label.querySelector('input:checked')
          ),
        'the replaced filter',
      )
      expect(await checkedTopics()).toEqual(['Post-harvest and supply chain'])

      await typeInto(page, '#header-search', 'bycatch')
      await settle(page, listboxOpen, 'the suggestion list')
      const question = (await options(page)).findIndex((row) => row.text.startsWith('What does'))
      expect(question).toBeGreaterThan(1)
      await page.evaluate((id) => document.getElementById(id)!.click(), {
        args: [(await options(page))[question]!.id],
      })
      await settle(page, () => location.pathname === '/t/marine/ask', 'the ask page')
      // Ask takes the question from the address and sends it.
      await settle(
        page,
        () =>
          document.querySelector('main')?.textContent?.includes(
            'What does the latest research say about bycatch reduction in longline fisheries?',
          ) === true,
        'the asked question',
      )
    } finally {
      await page.close()
    }
  })

  it('fills the width of the hero ask field on a 320px phone, with 44px rows for a finger', async () => {
    const page = await browser.newPage(server.url)
    try {
      for (const width of [390, 320]) {
        await openPortal(page, width)
        const cdp = page.unsafelyGetCelestialBindings()
        await cdp.Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 1 })
        await typeInto(page, '#explore-search', 'heatwave')
        await settle(page, listboxOpen, 'the hero suggestion list')
        const layout = await page.evaluate(() => {
          const panel = document.querySelector('.rp-suggest-panel')!.getBoundingClientRect()
          const field = document.querySelector('.rp-hero-field')!.getBoundingClientRect()
          const heights = [...document.querySelectorAll('.rp-suggest-panel [role="option"]')].map((
            option,
          ) => option.getBoundingClientRect().height)
          return {
            left: panel.left - field.left,
            right: panel.right - field.right,
            overflow: document.documentElement.scrollWidth - innerWidth,
            coarse: matchMedia('(pointer: coarse)').matches,
            shortest: Math.min(...heights),
            first: document.querySelector('.rp-suggest-panel [role="option"]')?.textContent,
          }
        })
        expect(layout.left).toBe(0)
        expect(layout.right).toBe(0)
        expect(layout.overflow).toBeLessThanOrEqual(0)
        // The hero asks first.
        expect(layout.first).toBe('Ask “heatwave”')
        if (layout.coarse) expect(layout.shortest).toBeGreaterThanOrEqual(44)
        await shot(page, `hero-open-${width}-light`)
        await cdp.Emulation.setTouchEmulationEnabled({ enabled: false })
      }
    } finally {
      await page.close()
    }
  })

  it('draws the open list from theme tokens in the dark scheme', async () => {
    const page = await browser.newPage(server.url)
    try {
      await openPortal(page, 1440, 'dark')
      await typeInto(page, '#header-search', 'ab')
      await settle(page, listboxOpen, 'the suggestion list')
      await page.keyboard.press('ArrowDown')
      const colours = await page.evaluate(() => {
        const panel = document.querySelector('.rp-suggest-panel')!
        const active = document.querySelector('.rp-suggest-option-active')!
        const vars = getComputedStyle(document.body)
        const resolve = (value: string) => {
          const probe = document.createElement('span')
          probe.style.color = value
          document.body.append(probe)
          const colour = getComputedStyle(probe).color
          probe.remove()
          return colour
        }
        return {
          panel: getComputedStyle(panel).backgroundColor,
          surface: resolve(vars.getPropertyValue('--rp-surface')),
          active: getComputedStyle(active).backgroundColor,
          surface2: resolve(vars.getPropertyValue('--rp-surface-2')),
          scheme: getComputedStyle(document.body).colorScheme,
        }
      })
      expect(colours.scheme).toBe('dark')
      expect(colours.panel).toBe(colours.surface)
      expect(colours.active).toBe(colours.surface2)
      await shot(page, 'header-open-1440-dark')
    } finally {
      await page.close()
    }
  })
})

/** The palettes the hero chips are measured on. */
const PALETTES: { name: string; branding: (base: Branding) => Branding }[] = [
  { name: 'default', branding: (base) => ({ ...base, paletteId: 'default' }) },
  { name: 'corpuskit', branding: (base) => ({ ...base, paletteId: 'corpuskit' }) },
  {
    name: 'own-colours',
    branding: (base) => ({
      ...base,
      paletteId: 'default',
      colours: { primary: '#1C1C1C', accent: '#00B14E', heroFrom: '#00B14E', heroTo: '#7FD8A6' },
    }),
  },
]

describe('hero question chips', () => {
  for (const palette of PALETTES) {
    for (const scheme of ['light', 'dark'] as const) {
      it(`keep 4.5:1 ink and a 3:1 edge on the ${palette.name} palette, ${scheme}`, async () => {
        // The scheme as the portal's own default too: the house identity otherwise opens light.
        server.tenants.patch('marine', {
          branding: { ...palette.branding(initialBranding), defaultColourScheme: scheme },
        })
        const page = await browser.newPage(server.url)
        try {
          for (const width of [1440, 390]) {
            await openPortal(page, width, scheme)
            expect(await page.evaluate(() => getComputedStyle(document.body).colorScheme)).toBe(
              scheme,
            )
            const measured = await page.evaluate(() => {
              const canvas = document.createElement('canvas').getContext('2d', {
                willReadFrequently: true,
              })!
              /** Any CSS colour as straight sRGB channels and alpha, via the canvas. */
              const rgba = (css: string): [number, number, number, number] => {
                canvas.clearRect(0, 0, 1, 1)
                canvas.fillStyle = css
                canvas.fillRect(0, 0, 1, 1)
                const [r, g, b, a] = canvas.getImageData(0, 0, 1, 1).data
                return [r!, g!, b!, a! / 255]
              }
              const over = (top: string, under: string): [number, number, number] => {
                const [r, g, b, a] = rgba(top)
                const [ur, ug, ub] = rgba(under)
                return [r * a + ur * (1 - a), g * a + ug * (1 - a), b * a + ub * (1 - a)]
              }
              const luminance = ([r, g, b]: [number, number, number]) => {
                const linear = (c: number) => {
                  const s = c / 255
                  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
                }
                return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
              }
              const contrast = (a: [number, number, number], b: [number, number, number]) => {
                const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
                return (hi! + 0.05) / (lo! + 0.05)
              }
              const chip = document.querySelector<HTMLElement>('.rp-pages-hero-chip')!
              const style = getComputedStyle(chip)
              const hero = getComputedStyle(chip.closest('section')!)
              // The hero is a gradient (or a flat brand ground): measure on both of its ends.
              const ends = [
                hero.getPropertyValue('--rp-hero-from'),
                hero.getPropertyValue('--rp-hero-to'),
              ]
                .map((value) => value.trim())
              let text = Infinity
              let edge = Infinity
              for (const end of ends) {
                const ground = over(end, 'rgb(0, 0, 0)')
                const groundCss = `rgb(${ground.join(',')})`
                const fill = over(style.backgroundColor, groundCss)
                const ink = over(style.color, `rgb(${fill.join(',')})`)
                text = Math.min(text, contrast(ink, fill))
                const border = over(style.borderTopColor, groundCss)
                edge = Math.min(edge, Math.max(contrast(border, ground), contrast(fill, ground)))
              }
              return {
                text,
                edge,
                height: chip.getBoundingClientRect().height,
                arrow: chip.querySelector('svg') !== null,
                borderWidth: style.borderTopWidth,
              }
            })
            expect(measured.text).toBeGreaterThanOrEqual(4.5)
            expect(measured.edge).toBeGreaterThanOrEqual(3)
            expect(measured.height).toBeGreaterThanOrEqual(44)
            expect(measured.arrow).toBe(true)
            expect(measured.borderWidth).toBe('1px')
            console.log(
              `${palette.name} ${scheme} ${width}: text ${measured.text.toFixed(2)}:1, edge ${
                measured.edge.toFixed(2)
              }:1`,
            )
            await shot(page, `chips-${palette.name}-${scheme}-${width}`)
          }
        } finally {
          await page.close()
          server.tenants.patch('marine', { branding: initialBranding })
        }
      })
    }
  }
})
