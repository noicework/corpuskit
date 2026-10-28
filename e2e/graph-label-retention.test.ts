import { expect } from '@std/expect'
import { launch } from '@astral/astral'
import { startTestServer } from './support/test-server.ts'
import { buildComponentFixture, sourcePath } from './support/rbac-fixture.ts'

Deno.test('3D labels retain identity and order through locale reflow and graph refreshes', async () => {
  const fixture = await buildComponentFixture({
    entrySource: `
import { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { KnowledgeMap3D } from '${sourcePath('apps/web/src/components/KnowledgeMap3D.tsx')}'
import { buildGroupStyles, buildDegrees } from '${
      sourcePath('apps/web/src/components/KnowledgeMap.tsx')
    }'
import { createPortalLocale, PortalLocaleContext } from '${
      sourcePath('apps/web/src/lib/portal-locale.tsx')
    }'
const initial=[
  {id:'Material',label:'Material',group:'Material',weight:2},
  {id:'EX-M20-032',label:'EX-M20-032',group:'Experiment',weight:1},
  {id:'Original',label:'Original',group:'Material',weight:1},
]
const edges=[], degrees=buildDegrees(edges), hiddenGroups=new Set()
function App(){
  const [language,setLanguage]=useState('ja'), [revision,setRevision]=useState(0)
  const nodes=useMemo(()=>{
    if(revision===0) return initial
    const updated=initial.map(n=>({...n,label:n.label+' updated'})).reverse()
    if(revision===1) return updated
    const remaining=updated.filter(n=>n.id!=='EX-M20-032')
    return revision===2 ? remaining : [...remaining,{id:'Added',label:'Added',group:'Experiment',weight:1}]
  },[revision])
  const groupStyles=useMemo(()=>buildGroupStyles(nodes),[nodes])
  return <PortalLocaleContext.Provider value={createPortalLocale(language)}>
    <button id='locale-ja' onClick={()=>setLanguage('ja')}>JA</button>
    <button id='locale-en' onClick={()=>setLanguage('en')}>EN</button>
    <button id='refresh' onClick={()=>setRevision(1)}>Refresh</button>
    <button id='remove' onClick={()=>setRevision(2)}>Remove</button>
    <button id='add' onClick={()=>setRevision(3)}>Add</button>
    <div id='map' data-language={language} style={{position:'relative',width:language==='ja'?960:390,height:650}}>
      <KnowledgeMap3D nodes={nodes} edges={edges} groupStyles={groupStyles} degrees={degrees}
        measure='links' layout='grouped' hiddenGroups={hiddenGroups} selectedId={null}
        pathEdges={null} pathFrom={null} onSelect={()=>{}} focusId={null}
        insets={{top:0,left:0,right:0,bottom:0}} hint=''/>
    </div>
  </PortalLocaleContext.Provider>
}
createRoot(document.getElementById('root')).render(<App/>);
`,
  })
  const server = startTestServer({ componentFixture: fixture })
  const browser = await launch(), page = await browser.newPage('about:blank')
  try {
    await page.bringToFront()
    await page.unsafelyGetCelestialBindings().Emulation.setCPUThrottlingRate({
      rate: Number(Deno.env.get('GRAPH_CPU_THROTTLE') ?? 1),
    })
    await page.setViewportSize({ width: 1280, height: 960 })
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
    await page.goto(`${server.url}/__test/rbac-component`)
    await page.waitForFunction(() =>
      document.querySelector('canvas')?.width === 960 &&
      document.querySelectorAll('.rp-map3d-label').length === 3 &&
      document.querySelectorAll('.rp-map3d-territory').length === 2
    )
    // Capture the settled initial scene, before deliberately changing its shape.
    await page.evaluate(() =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
    )
    await page.evaluate(() => {
      Reflect.set(globalThis, 'retainedLabels', [...document.querySelectorAll('.rp-map3d-label')])
      Reflect.set(globalThis, 'retainedCaptions', [
        ...document.querySelectorAll('.rp-map3d-territory'),
      ])
      const retained = new Set([
        ...document.querySelectorAll('.rp-map3d-label, .rp-map3d-territory'),
      ])
      Reflect.set(globalThis, 'retainedLabelRemovals', 0)
      new MutationObserver((records) => {
        for (const record of records) {
          for (const removed of record.removedNodes) {
            if (retained.has(removed as Element)) {
              Reflect.set(
                globalThis,
                'retainedLabelRemovals',
                Reflect.get(globalThis, 'retainedLabelRemovals') + 1,
              )
            }
          }
        }
      }).observe(document.querySelector('.rp-map3d-labels')!, { childList: true })
    })
    for (const language of ['en', 'ja', 'en']) {
      await (await page.waitForSelector(`#locale-${language}`)).click()
      await page.waitForFunction(
        (width, caption) =>
          document.querySelector('canvas')?.width === width &&
          [...document.querySelectorAll('.rp-map3d-territory')].some((el) =>
            el.textContent?.includes(caption)
          ),
        {
          args: [language === 'ja' ? 960 : 390, language === 'ja' ? '材料' : 'Material'],
        },
      )
      // Cross the ResizeObserver and React effect paint boundaries as well as setUi.
      await page.evaluate(() =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              resolve()
            })
          )
        )
      )
      const retained = await page.evaluate(() => {
        const labels = [...document.querySelectorAll('.rp-map3d-label')]
        const captions = [...document.querySelectorAll('.rp-map3d-territory')]
        return {
          labels: (Reflect.get(globalThis, 'retainedLabels') as Element[])
            .every((el, index) => el === labels[index]),
          captions: (Reflect.get(globalThis, 'retainedCaptions') as Element[])
            .every((el, index) => el === captions[index]),
          removals: Reflect.get(globalThis, 'retainedLabelRemovals') as number,
        }
      })
      expect(retained).toEqual({ labels: true, captions: true, removals: 0 })
    }

    await (await page.waitForSelector('#refresh')).click()
    await page.waitForFunction(() =>
      document.querySelector('.rp-map3d-label')?.textContent?.endsWith(' updated')
    )
    expect(
      await page.evaluate(() => {
        const labels = [...document.querySelectorAll('.rp-map3d-label')]
        return (Reflect.get(globalThis, 'retainedLabels') as Element[])
          .every((el, index) => el === labels[index] && el.textContent?.endsWith(' updated')) &&
          Reflect.get(globalThis, 'retainedLabelRemovals') === 0
      }),
    ).toBe(true)

    await (await page.waitForSelector('#remove')).click()
    await page.waitForFunction(() =>
      document.querySelectorAll('.rp-map3d-label').length === 2 &&
      document.querySelectorAll('.rp-map3d-territory').length === 0
    )
    expect(
      await page.evaluate(() => {
        const labels = Reflect.get(globalThis, 'retainedLabels') as Element[]
        const captions = Reflect.get(globalThis, 'retainedCaptions') as Element[]
        return labels[0]!.isConnected && !labels[1]!.isConnected && labels[2]!.isConnected &&
          captions.every((el) => !el.isConnected)
      }),
    ).toBe(true)

    await (await page.waitForSelector('#add')).click()
    await page.waitForFunction(() =>
      document.querySelectorAll('.rp-map3d-label').length === 3 &&
      document.querySelectorAll('.rp-map3d-territory').length === 2
    )
    expect(
      await page.evaluate(() => {
        const labels = [...document.querySelectorAll('.rp-map3d-label')]
        const original = Reflect.get(globalThis, 'retainedLabels') as Element[]
        return labels[0] === original[0] && labels[1] === original[2] &&
          labels[2]?.textContent === 'Added'
      }),
    ).toBe(true)
    expect(server.providerCalls).toEqual([])
  } finally {
    await page.close()
    await browser.close()
    await server.close()
    await fixture.close()
  }
})
