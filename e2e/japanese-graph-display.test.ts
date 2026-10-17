import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import { startTestServer } from './support/test-server.ts'
import { assertCurrentBuild, buildComponentFixture, sourcePath } from './support/rbac-fixture.ts'
import { DoubleProvider } from './support/double-provider.ts'
import { createPortalLocale } from '../apps/web/src/lib/portal-locale.tsx'
import type { BuildAppOptions } from '../apps/api/src/app.ts'

const nodes = [
  { id: 'EX-M20-032', group: 'Experiment', weight: 3 },
  { id: 'AP-M0', group: 'Material', weight: 2 },
  { id: 'Library {name}', group: 'Research topic', weight: 1 },
  { id: 'Material', group: 'Summary {count}', weight: 1 },
  ...Array.from({ length: 8 }, (_, i) => ({ id: `Original-${i}`, group: 'Material', weight: 1 })),
]
const edges = [
  { source: 'EX-M20-032', target: 'AP-M0', label: 'uses material' },
  { source: 'EX-M20-032', target: 'Library {name}', label: 'examines' },
  { source: 'EX-M20-032', target: 'Material', label: '' },
  { source: 'AP-M0', target: 'Material', label: 'Summary {count}' },
]

async function clickButton(page: Page, name: string) {
  await page.evaluate((name) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => {
        const labelledBy = button.getAttribute('aria-labelledby')?.split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent?.trim() ?? '').join(' ')
        const label = labelledBy || button.getAttribute('aria-label') || button.textContent?.trim()
        return label === name && button.getBoundingClientRect().width > 0
      })
    if (!button) throw new Error(`Missing fixture control: ${name}`)
    button.click()
  }, { args: [name] })
}

async function findNode(page: Page, name: string, language: 'ja' | 'en') {
  const { ui } = createPortalLocale(language)
  await page.evaluate((label) => {
    const visible = [...document.querySelectorAll<HTMLInputElement>('input')]
      .some((input) => input.getBoundingClientRect().width > 0)
    if (!visible) {
      document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click()
    }
  }, { args: [ui('Find in the map')] })
  const input = await page.waitForSelector(`input[aria-label="${ui('Find an entity in the map')}"]`)
  await input.type(name)
  await page.waitForFunction(
    (name) =>
      [...document.querySelectorAll<HTMLElement>('span[title]')].some((span) =>
        span.title === name
      ),
    { args: [name] },
  )
  const group = await page.evaluate((name) => {
    const result = [...document.querySelectorAll<HTMLElement>('span[title]')]
      .find((span) => span.title === name)!
    const group = result.nextElementSibling?.textContent?.trim()
    result.closest<HTMLButtonElement>('button')!.click()
    return group
  }, { args: [name] })
  await page.waitForFunction(
    (name) =>
      [...document.querySelectorAll('aside h2')].some((heading) => heading.textContent === name),
    { args: [name] },
  )
  return group
}

Deno.test('graph display aliases switch on the real graph and dossier at wide390 light dark22px', async () => {
  const calls: string[] = []
  const management = new Proxy({}, {
    get: (_target, method) => (...args: unknown[]) => {
      calls.push(String(method))
      switch (method) {
        case 'relationsGraph':
          return Promise.resolve({ nodes, edges })
        case 'entityGroups':
          return Promise.resolve([])
        case 'listAgents':
        case 'labelsets':
          return Promise.resolve([])
        case 'thumbnailResponse':
          return Promise.resolve(new Response(null, { status: 404 }))
        default:
          return Promise.reject(
            new Error(`Unexpected fixture operation: ${String(method)} ${args.length}`),
          )
      }
    },
  }) as NonNullable<BuildAppOptions['management']>
  const server = startTestServer({
    identity: { role: 'owner' },
    management,
    provider: new DoubleProvider(),
  })
  server.tenants.patch('marine', {
    languagePolicy: { defaultLanguage: 'ja', availableLanguages: ['ja', 'en'] },
  })
  const directory = '.planning/logs/japanese-graph-display'
  const manifest: unknown[] = []
  try {
    for (const dark of [false, true]) {
      for (const width of [1440, 390]) {
        const browser = await launch(), page = await browser.newPage('about:blank')
        try {
          await page.bringToFront()
          await page.setViewportSize({ width, height: 1100 })
          await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
          await page.goto(`${server.url}/t/marine/graph`)
          await page.waitForSelector('.rp-map3d canvas')
          await assertCurrentBuild(page)
          await page.evaluate(
            (label) =>
              document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)?.click(),
            {
              args: [
                createPortalLocale('ja').ui(dark ? 'Switch to dark mode' : 'Switch to light mode'),
              ],
            },
          )
          await page.evaluate(() => {
            document.documentElement.style.fontSize = '22px'
          })
          await page.waitForFunction(() =>
            document.fonts.status === 'loaded' &&
            getComputedStyle(document.documentElement).fontSize === '22px'
          )
          await page.waitForFunction(() =>
            [...document.querySelectorAll<HTMLElement>('.rp-map3d-label')].some((el) =>
              el.style.display !== 'none'
            )
          )
          if (width === 390) {
            await clickButton(page, createPortalLocale('ja').ui('Browse'))
          }
          const navigator = createPortalLocale('ja').ui('Map navigator')
          expect(
            await page.evaluate(
              (navigator) =>
                document.querySelector(`aside[aria-label="${navigator}"]`)?.textContent,
              {
                args: [navigator],
              },
            ),
          ).toContain('すべての項目を表示（12件）')
          expect(await findNode(page, 'EX-M20-032', 'ja')).toBe('実験')
          await clickButton(page, createPortalLocale('ja').ui('Trace a connection'))
          await findNode(page, 'AP-M0', 'ja')
          await clickButton(page, createPortalLocale('ja').ui('Expand connections'))
          await page.waitForFunction(
            (label) =>
              [...document.querySelectorAll('button')].some((button) =>
                button.textContent?.trim() === label
              ),
            { args: [createPortalLocale('ja').ui('Expand connections')] },
          )
          await page.waitForFunction(() =>
            document.querySelectorAll('.rp-map3d-label').length === 12
          )
          await page.evaluate(() => {
            ;(globalThis as unknown as { retainedGraphLabel: Element | null }).retainedGraphLabel =
              document.querySelector('.rp-map3d-label')
          })
          for (const language of ['ja', 'en', 'ja'] as const) {
            const { ui } = createPortalLocale(language)
            await page.evaluate(
              (language) =>
                document.querySelector<HTMLButtonElement>(`button[lang="${language}"]`)!.click(),
              { args: [language] },
            )
            await page.waitForFunction((text) => document.body.innerText.includes(text), {
              args: [ui('Open dossier')],
            })
            const state = await page.evaluate(() => ({
              retained: (globalThis as unknown as { retainedGraphLabel: Element | null })
                .retainedGraphLabel === document.querySelector('.rp-map3d-label'),
              selected: document.querySelector('aside h2')?.textContent,
              dock: document.querySelector('aside[tabindex="-1"]')?.textContent,
              path: document.querySelector('aside ol')?.textContent,
              width: innerWidth,
              scroll: document.documentElement.scrollWidth,
              font: getComputedStyle(document.documentElement).fontSize,
              scheme: getComputedStyle(document.body).colorScheme,
            }))
            expect(state.retained).toBe(true)
            expect(state.selected).toBe('AP-M0')
            expect(state.dock).toContain(language === 'ja' ? '材料' : 'Material')
            expect(state.path).toContain('EX-M20-032')
            expect(state.path).toContain(language === 'ja' ? '材料として使用する' : 'uses material')
            expect(state.width).toBe(width)
            expect(state.scroll).toBeLessThanOrEqual(width + 1)
            expect(state.font).toBe('22px')
            expect(state.scheme).toBe(dark ? 'dark' : 'light')
            manifest.push({ dark, language, ...state })
            await Deno.mkdir(directory, { recursive: true })
            await Deno.writeFile(
              `${directory}/graph-${language}-${dark ? 'dark' : 'light'}-${width}.png`,
              await page.screenshot(),
            )
          }
          await page.goto(`${server.url}/t/marine/entity/AP-M0`)
          await page.waitForFunction(() =>
            document.querySelector('main h1')?.textContent === 'AP-M0'
          )
          const dossier = await page.evaluate(() => document.querySelector('main')?.innerText)
          expect(dossier).toContain('材料')
          expect(dossier).toContain('材料として使用する')
          expect(dossier).toContain('Summary {count}')
          expect(dossier).toContain('Abalone stock health in southern waters')
        } finally {
          await page.close()
          await browser.close()
        }
      }
    }
    expect(calls.some((method) => /ask|generate|startAgent|run/i.test(method))).toBe(false)
    expect(server.providerCalls.some((method) => /ask|generate/i.test(method))).toBe(false)
    const expansions = server.requests.filter((r) => r.path.includes('/graph/relations?entity='))
    expect(expansions.length).toBe(4)
    expect(
      expansions.every((r) => !/[実験材料]/u.test(decodeURIComponent(r.path))),
    ).toBe(true)
    expect(
      expansions.every((r) => new URL(r.path, server.url).searchParams.get('entity') === 'AP-M0'),
    ).toBe(true)
    await Deno.writeTextFile(`${directory}/manifest.json`, JSON.stringify(manifest, null, 2))
  } finally {
    await server.close()
  }
})

Deno.test('retained WebGL captions popup edges and SVG trace translate without changing identities', async () => {
  const fixture = await buildComponentFixture({
    entrySource: `
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { KnowledgeMap3D } from '${sourcePath('apps/web/src/components/KnowledgeMap3D.tsx')}'
import { KnowledgeMap, buildGroupStyles, buildDegrees } from '${
      sourcePath('apps/web/src/components/KnowledgeMap.tsx')
    }'
import { createPortalLocale, PortalLocaleContext } from '${
      sourcePath('apps/web/src/lib/portal-locale.tsx')
    }'
const nodes=[{id:'Material',label:'Material',group:'Material',weight:2},{id:'EX-M20-032',label:'EX-M20-032',group:'Experiment',weight:1}]
const edges=[{source:'EX-M20-032',target:'Material',label:'uses material',weight:1}]
const props={nodes,edges,groupStyles:buildGroupStyles(nodes),degrees:buildDegrees(edges),measure:'links',layout:'grouped',hiddenGroups:new Set(),selectedId:null,pathEdges:edges,pathFrom:null,onSelect:()=>{},focusId:null,insets:{top:0,left:0,right:0,bottom:0},hint:''}
function App(){const[language,setLanguage]=useState('ja');return <PortalLocaleContext.Provider value={createPortalLocale(language)}>
<button id='locale-ja' onClick={()=>setLanguage('ja')}>JA</button><button id='locale-en' onClick={()=>setLanguage('en')}>EN</button>
<div id='webgl' style={{position:'relative',height:650}}><KnowledgeMap3D {...props}/></div>
<div id='svg' style={{position:'relative',height:650}}><KnowledgeMap {...props}/></div>
</PortalLocaleContext.Provider>}
createRoot(document.getElementById('root')).render(<App/>);
`,
  })
  const server = startTestServer({ componentFixture: fixture })
  const browser = await launch(), page = await browser.newPage('about:blank')
  try {
    await page.bringToFront()
    await page.setViewportSize({ width: 1100, height: 1500 })
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
    await page.goto(`${server.url}/__test/rbac-component`)
    await page.waitForSelector('.rp-map3d canvas')
    await page.waitForFunction(() =>
      [...document.querySelectorAll<HTMLElement>('.rp-map3d-label')].some((el) =>
        el.style.display !== 'none'
      )
    )
    await page.evaluate(() => {
      const label = [...document.querySelectorAll<HTMLElement>('.rp-map3d-label')].find((el) =>
        el.textContent === 'Material'
      )!
      const rect = label.getBoundingClientRect()
      document.querySelector('canvas')!.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: rect.left + rect.width / 2,
          clientY: rect.bottom + 16,
          pointerType: 'mouse',
        }),
      )
      ;(globalThis as unknown as { retained: Element }).retained = label
    })
    await page.waitForFunction(() =>
      document.querySelector<HTMLElement>('.rp-map3d-popup')?.style.display === 'block'
    )
    for (const language of ['ja', 'en', 'ja'] as const) {
      await (await page.waitForSelector(`#locale-${language}`)).click()
      const category = language === 'ja' ? '材料' : 'Material'
      await page.waitForFunction(
        (category) => document.querySelector('.rp-map3d-popup-meta')?.textContent === category,
        { args: [category] },
      )
      await page.waitForFunction(
        (caption, relation) =>
          [...document.querySelectorAll('.rp-map3d-territory')].some((el) =>
            el.textContent?.includes(caption)
          ) &&
          [...document.querySelectorAll('.rp-map3d-edge-label')].some((el) =>
            el.textContent === relation
          ),
        {
          args: [
            language === 'ja' ? '実験' : 'Experiment',
            language === 'ja' ? '材料として使用する' : 'uses material',
          ],
        },
      )
      const state = await page.evaluate(() => ({
        retained: (globalThis as unknown as { retained: Element }).retained ===
          [...document.querySelectorAll('.rp-map3d-label')].find((el) =>
            el.textContent === 'Material'
          ),
        name: document.querySelector('.rp-map3d-popup-name')?.textContent,
        captions: [...document.querySelectorAll('.rp-map3d-territory')].map((el) => el.textContent),
        edges: [...document.querySelectorAll('.rp-map3d-edge-label')].map((el) => el.textContent),
        traced: [...document.querySelectorAll('#svg path[stroke="var(--rp-accent)"]')].map((
          el,
        ) => ({
          width: el.getAttribute('stroke-width'),
          opacity: el.parentElement?.getAttribute('opacity'),
        })),
      }))
      expect(state.retained).toBe(true)
      expect(state.name).toBe('Material')
      expect(state.captions.join(' ')).toContain(language === 'ja' ? '実験' : 'Experiment')
      expect(state.edges).toContain(language === 'ja' ? '材料として使用する' : 'uses material')
      expect(state.traced).toContainEqual({ width: '3', opacity: '1' })
      await Deno.mkdir('.planning/logs/japanese-graph-display', { recursive: true })
      await Deno.writeFile(
        `.planning/logs/japanese-graph-display/popup-${language}.png`,
        await page.screenshot(),
      )
    }
    expect(server.providerCalls).toEqual([])
  } finally {
    await page.close()
    await browser.close()
    await server.close()
    await fixture.close()
  }
})
