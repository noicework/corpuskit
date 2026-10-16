import { expect } from '@std/expect'
import { launch } from '@astral/astral'
import { startTestServer } from './support/test-server.ts'
import { buildComponentFixture, sourcePath } from './support/rbac-fixture.ts'

export async function japaneseMapCopyFixture() {
  const fixture = await buildComponentFixture({
    entrySource: `
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { KnowledgeMap3D } from '${sourcePath('apps/web/src/components/KnowledgeMap3D.tsx')}'
import { createPortalLocale, PortalLocaleContext } from '${
      sourcePath('apps/web/src/lib/portal-locale.tsx')
    }'
const nodes = [{ id:'Library', label:'Library {name}', group:'Summary', weight:2 }]
const edges = []
const groups = new Map([['Summary',{slot:0,colour:'#306080',ink:'#102030',hollow:false,count:1}]])
const degrees = new Map([['Library',1]])
const hidden = new Set()
const insets = {top:0,left:0,right:0,bottom:0}
function App() {
  const [language,setLanguage] = useState('ja')
  return <PortalLocaleContext.Provider value={createPortalLocale(language)}>
    <button id='locale-ja' onClick={()=>setLanguage('ja')}>JA</button>
    <button id='locale-en' onClick={()=>setLanguage('en')}>EN</button>
    <div style={{position:'relative',height:'650px',width:'100%'}}>
      <KnowledgeMap3D nodes={nodes} edges={edges} groupStyles={groups} degrees={degrees}
       measure='links' layout='grouped' hiddenGroups={hidden} selectedId={null} pathEdges={null}
       pathFrom={null} onSelect={()=>{}} focusId={null} insets={insets} hint='' />
    </div>
  </PortalLocaleContext.Provider>
}
createRoot(document.getElementById('root')).render(<App />)
`,
  })
  return { fixture, server: startTestServer({ componentFixture: fixture }) }
}

Deno.test('actual WebGL popup switches finite Japanese English copy without translating graph names', async () => {
  const { fixture, server } = await japaneseMapCopyFixture()
  const browser = await launch(), page = await browser.newPage('about:blank')
  let stage = 'load'
  const errors: string[] = []
  page.addEventListener('pageerror', (event) => errors.push(event.detail.message))
  try {
    await page.bringToFront()
    await page.setViewportSize({ width: 1100, height: 850 })
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
    await page.goto(`${server.url}/__test/rbac-component`)
    stage = 'WebGL canvas'
    await page.waitForSelector('.rp-map3d canvas')
    stage = 'visible labels'
    await page.waitForFunction(() =>
      [...document.querySelectorAll<HTMLElement>('.rp-map3d-label')].some((element) =>
        element.style.display !== 'none'
      )
    )
    await page.bringToFront()
    await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('.rp-map3d canvas')!
      const label = document.querySelector<HTMLElement>('.rp-map3d-label')!.getBoundingClientRect()
      canvas.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: label.left + label.width / 2,
          clientY: label.bottom + 16,
          pointerType: 'mouse',
        }),
      )
    })
    stage = 'hover popup'
    await page.waitForFunction(() =>
      document.querySelector<HTMLElement>('.rp-map3d-popup')?.style.display === 'block'
    )
    for (const language of ['ja', 'en', 'ja'] as const) {
      stage = `locale ${language}`
      await (await page.waitForSelector(`#locale-${language}`)).click()
      const hint = language === 'ja' ? 'クリックして詳しく見る' : 'Click to explore'
      await page.waitForFunction(
        (hint) => document.querySelector('.rp-map3d-popup-hint')?.textContent === hint,
        { args: [hint] },
      )
      expect(
        await page.evaluate(() => ({
          name: document.querySelector('.rp-map3d-popup-name')?.textContent,
          group: document.querySelector('.rp-map3d-popup-meta')?.textContent,
          counts: document.querySelector('.rp-map3d-popup-counts')?.textContent,
          shown: document.querySelector<HTMLElement>('.rp-map3d-popup')?.style.display,
        })),
      ).toEqual({
        name: 'Library {name}',
        group: 'Summary',
        counts: language === 'ja' ? '関連1件 · 言及2件' : '1 relation · 2 mentions',
        shown: 'block',
      })
      await Deno.mkdir('.planning/logs/japanese-map-copy', { recursive: true })
      await Deno.writeFile(
        `.planning/logs/japanese-map-copy/popup-${language}.png`,
        await page.screenshot(),
      )
    }
    expect(server.providerCalls).toEqual([])
  } catch (error) {
    console.error({
      stage,
      errors,
      snapshot: await page.evaluate(() => ({
        text: document.body.innerText,
        labels: [...document.querySelectorAll<HTMLElement>('.rp-map3d-label')].map((element) => ({
          text: element.textContent,
          display: element.style.display,
          box: element.getBoundingClientRect().toJSON(),
        })),
        popup: document.querySelector('.rp-map3d-popup')?.textContent,
      })),
    })
    throw error
  } finally {
    await page.close()
    await browser.close()
    await server.close()
    await fixture.close()
  }
})
