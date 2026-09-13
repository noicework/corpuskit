import { expect } from '@std/expect'
import { launch } from '@astral/astral'
import { fixtureSession } from '../apps/api/src/rbac-integration-fixture.ts'
import { startTestServer } from './support/test-server.ts'
import type { BuildAppOptions } from '../apps/api/src/app.ts'
import {
  assertCurrentBuild,
  buildComponentFixture,
  captureBoundary,
  sourcePath,
} from './support/rbac-fixture.ts'

// Test-only observers expose old QueryClients and AbortSignals. All authority,
// cache ownership, gates and request publication use the production modules.
const source = `
import {useEffect,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {BrowserRouter,useNavigate} from 'react-router-dom'
import {useQuery,useQueryClient} from '@tanstack/react-query'
import {AccessProvider,useAccess,useScopeAccess} from '${
  sourcePath('apps/web/src/components/AccessProvider.tsx')
}'
import {PortalAccessGate} from '${sourcePath('apps/web/src/components/PortalAccessGate.tsx')}'
import {request} from '${sourcePath('apps/web/src/api/client.ts')}'
const clients=[],signals=[]
const originalFetch=fetch
globalThis.fetch=(input,init)=>{if(String(input).includes('/search?'))signals.push(init?.signal);return originalFetch(input,init)}
globalThis.inspectLifecycle=()=>({caches:JSON.stringify(clients.map(c=>c.getQueryCache().getAll().map(q=>q.state.data))),aborted:signals.map(s=>s?.aborted)})
function Controls(){const navigate=useNavigate();useEffect(()=>{const move=()=>navigate('/t/grains');const deny=()=>void request('/api/admin/overview').catch(()=>{});addEventListener('move-scope',move);addEventListener('server-denial',deny);return()=>{removeEventListener('move-scope',move);removeEventListener('server-denial',deny)}},[navigate]);return null}
function Scope({slug}){const scope=useScopeAccess(slug);return <span data-scope={slug} data-ready={scope.state} data-read={scope.can('portal.read')}/>}
function Panel(){const access=useAccess(),client=useQueryClient();const [search,setSearch]=useState(0);useEffect(()=>{clients.push(client)},[client]);const config=useQuery({queryKey:['config-marker'],queryFn:()=>request('/api/t/'+access.slug+'/config')});const result=useQuery({queryKey:['search-marker',search],enabled:search>0,queryFn:({signal})=>request('/api/t/'+access.slug+'/search?q=abalone&attempt='+search,undefined,{signal})});return <main className='p-6'><h1>Research lifecycle</h1><p data-private>{config.data?.branding?.tagline}</p><button className='rp-btn' onClick={()=>setSearch(value=>value+1)}>Search protected corpus</button><pre data-result>{result.data?JSON.stringify(result.data):''}</pre><Scope slug='marine'/>{access.state.session?.authenticated&&<Scope slug='grains'/>}<span data-page-scope={access.slug}/></main>}
createRoot(document.getElementById('root')).render(<BrowserRouter><AccessProvider><Controls/><PortalAccessGate><Panel/></PortalAccessGate></AccessProvider></BrowserRouter>)
`

for (
  const transition of [
    'identity',
    'signout',
    'assignment',
    'mode',
    'scope',
    'auth-failure',
    '401',
    '403',
  ] as const
) {
  Deno.test(`observed ${transition} retires populated caches and pending real search before late release`, async () => {
    const component = await buildComponentFixture({ entrySource: source })
    const server = startTestServer({
      componentFixture: component,
      identity: { role: 'analyst' },
      breakGlass: true,
    })
    server.setAccessMode('marine', transition === 'mode' ? 'public' : 'restricted')
    server.setAccessMode('grains', 'restricted')
    if (transition === 'mode') server.setIdentity(null)
    server.tenants.patchBranding('marine', { tagline: 'Protected marine cache marker' })
    const browser = await launch()
    const page = await browser.newPage(`${server.url}/__test/rbac-component`)
    let release = () => {}
    let releaseAuth = () => {}
    try {
      await page.evaluate(() => {
        history.replaceState(null, '', '/t/marine')
        dispatchEvent(new PopStateEvent('popstate'))
      })
      await page.waitForFunction(() =>
        document.querySelector('[data-private]')?.textContent === 'Protected marine cache marker'
      )
      if (transition !== 'mode') await page.waitForSelector('[data-scope=grains][data-ready=ready]')
      expect(
        await page.evaluate(() =>
          document.querySelector('[data-page-scope]')?.getAttribute('data-page-scope')
        ),
      ).toBe('marine')
      if (transition !== 'mode') {
        expect(
          await page.evaluate(() =>
            document.querySelector('[data-scope=grains]')?.getAttribute('data-read')
          ),
        ).toBe('false')
      }
      await assertCurrentBuild(page)
      await page.evaluate(() => document.querySelector<HTMLButtonElement>('main button')!.click())
      await page.waitForFunction(() =>
        document.querySelector('[data-result]')?.textContent?.includes('Abalone')
      )
      const delayed = server.delayResponse('/api/t/marine/search')
      release = delayed.release
      await page.evaluate(() => document.querySelector<HTMLButtonElement>('main button')!.click())
      await delayed.entered
      const inspect = () =>
        page.evaluate(() =>
          (globalThis as unknown as { inspectLifecycle(): { caches: string; aborted: boolean[] } })
            .inspectLifecycle()
        )
      expect((await inspect()).caches).toContain('Protected marine cache marker')
      expect((await inspect()).aborted.at(-1)).toBe(false)
      expect((await inspect()).caches).toContain('Abalone')
      expect(server.requests.some((r) => r.path.includes('/search?') && r.status === 200)).toBe(
        true,
      )

      // A remote assignment change is deliberately invisible until an observed
      // focus/denial event. No polling or instant idle revocation is claimed.
      if (transition === 'identity') server.setIdentity(fixtureSession({ oid: 'no-access' }))
      if (transition === 'signout' || transition === '401') server.setIdentity(null)
      if (transition === 'assignment' || transition === '403') {
        server.setAssignment({ kind: 'portal', slug: 'marine' }, 'e2e-analyst', null)
      }
      if (transition === 'mode') server.setAccessMode('marine', 'restricted')
      if (transition === 'auth-failure') server.setResponseStatus('/auth/me?portal=marine', 503)
      expect(await page.evaluate(() => document.querySelector('[data-private]')?.textContent)).toBe(
        'Protected marine cache marker',
      )

      const denial = transition === '401' || transition === '403'
      if (!denial && transition !== 'scope') {
        const auth = server.delayResponse('/auth/me?portal=marine')
        releaseAuth = auth.release
      }
      await page.evaluate(
        (event) =>
          dispatchEvent(
            event === 'move-scope' || event === 'server-denial'
              ? new Event(event)
              : new Event('focus'),
          ),
        {
          args: [denial ? 'server-denial' : transition === 'scope' ? 'move-scope' : 'focus'],
        },
      )
      await page.waitForSelector(
        denial
          ? '[data-access-state=failed]'
          : transition === 'scope'
          ? '[data-access-state=denied]'
          : '[data-access-state=loading]',
      )
      const retired = await inspect()
      expect(retired.caches).not.toContain('Protected marine cache marker')
      expect(retired.aborted.at(-1)).toBe(true)
      expect(retired.caches).not.toContain('Abalone')
      expect(await page.evaluate(() => document.body.innerText)).not.toContain(
        'Protected marine cache marker',
      )
      expect(await page.$('[data-result]')).toBeNull()
      releaseAuth()
      await page.waitForSelector(
        denial || transition === 'auth-failure'
          ? '[data-access-state=failed]'
          : '[data-access-state=denied]',
      )
      delayed.release()
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)))
      expect((await inspect()).caches).not.toContain('Protected marine cache marker')
      expect(await page.evaluate(() => document.body.innerText)).not.toContain('Abalone')
      expect(await page.$('input[type=password]')).toBeNull()
      expect(server.requests.filter((r) => r.path.includes('/search?'))).toHaveLength(2)
      if (denial) {
        const calls = server.requests.filter((r) => r.path === '/api/admin/overview')
        expect(calls).toHaveLength(1)
        expect(calls[0]!.status).toBe(Number(transition))
      }
      expect(
        await page.evaluate(() =>
          Object.values(localStorage).concat(Object.values(sessionStorage)).join(' ')
        ),
      ).not.toContain('Protected marine cache marker')
      if (transition === 'auth-failure') {
        for (const scheme of ['light', 'dark']) {
          await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }])
          for (const width of [1440, 390]) {
            await captureBoundary(
              page,
              '.planning/logs/04-18-02',
              `retired-${scheme}-${width}`,
              width,
            )
          }
        }
      }
    } finally {
      release()
      releaseAuth()
      await page.close()
      await browser.close()
      await server.close()
      await component.close()
    }
  })
}

Deno.test('Ask verdict success is current and a pending verdict cannot restore output after downgrade', async () => {
  const server = startTestServer({
    identity: { role: 'portal-admin' },
    management: {
      rephrase: () => Promise.resolve(null),
      resourceExtraction: () =>
        Promise.resolve({
          text:
            'Surveys across the southern region recorded a sustained 12% decline in abalone populations since 2019, with marine heatwaves identified as the leading stressor.',
          chars: 156,
          paragraphs: 1,
        }),
      askStructured: () =>
        Promise.resolve({
          object: {
            verdicts: [{ id: 'res-1', verdict: 'supports', relevance: 'Protected verdict marker' }],
          },
        }),
    } as unknown as BuildAppOptions['management'],
  })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/ask`)
  let release = () => {}
  try {
    const ask = async (question: string) => {
      await page.waitForSelector('#ask-composer')
      await page.evaluate((question) => {
        const input = document.querySelector<HTMLTextAreaElement>('#ask-composer')!
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
          input,
          question,
        )
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }, { args: [question] })
      await page.waitForFunction(() =>
        !document.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled
      )
      await page.evaluate(() =>
        document.querySelector('#ask-composer')!.closest('form')!.requestSubmit()
      )
      await page.waitForFunction(() => document.body.textContent?.includes('Answer complete'))
      await page.evaluate(() =>
        [...document.querySelectorAll('button')].find((button) =>
          button.textContent?.includes('retrieved sources')
        )!.click()
      )
      await page.evaluate(() =>
        [...document.querySelectorAll('button')].find((button) =>
          button.textContent?.includes('Journey through the context')
        )!.click()
      )
    }
    await ask('What affects abalone populations?')
    await page.waitForFunction(() =>
      document.body.textContent?.includes('Protected verdict marker')
    )
    expect(server.requests.filter((r) => r.path.endsWith('/verdicts') && r.status === 200))
      .toHaveLength(1)
    await page.evaluate(() =>
      [...document.querySelectorAll('button')].find((button) =>
        button.textContent?.trim() === '+ New session'
      )!.click()
    )
    const pending = server.delayResponse('/api/t/marine/verdicts')
    release = pending.release
    await ask('How can abalone stocks recover?')
    await pending.entered
    server.setAssignment({ kind: 'portal', slug: 'marine' }, 'e2e-portal-admin', 'viewer')
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    await page.waitForFunction(() => !document.body.textContent?.includes('Deep research'))
    pending.release()
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 150)))
    expect(await page.evaluate(() => document.body.textContent)).not.toContain(
      'Protected verdict marker',
    )
    expect(
      await page.evaluate(() =>
        Object.values(localStorage).concat(Object.values(sessionStorage)).join(' ')
      ),
    ).not.toContain('Protected verdict marker')
    expect(server.requests.filter((r) => r.path.endsWith('/verdicts'))).toHaveLength(2)
    expect(await page.$('input[type=password]')).toBeNull()
  } catch (error) {
    console.log(
      await page.evaluate(() =>
        [...document.querySelectorAll('button')].map((button) => button.textContent)
      ),
    )
    console.log(server.requests)
    throw error
  } finally {
    release()
    await page.close()
    await browser.close()
    await server.close()
  }
})
