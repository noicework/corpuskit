import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import { startTestServer } from './support/test-server.ts'
import { assertCurrentBuild, captureBoundary } from './support/rbac-fixture.ts'
import type { BuildAppOptions } from '../apps/api/src/app.ts'
import { fixtureSession } from '../apps/api/src/rbac-integration-fixture.ts'

async function entered(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Expected delayed request')), 10000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function clickText(page: Page, label: string) {
  await page.evaluate((label) => {
    const button = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.trim() === label
    )
    if (!button) throw new Error(`Missing ${label}`)
    button.click()
  }, { args: [label] })
}

async function ask(page: Page, question = 'What affects abalone populations?') {
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
    !document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled
  )
  await page.evaluate(() =>
    document.querySelector('#ask-composer')!.closest('form')!.requestSubmit()
  )
}

Deno.test('obsolete SSE cannot publish after identity changes', async () => {
  const server = startTestServer({ identity: { role: 'viewer' } })
  const delayed = server.delayResponse('/api/t/marine/ask')
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/ask`)
  try {
    await ask(page, 'Obsolete private question about abalone')
    await entered(delayed.entered)
    server.setAccessMode('marine', 'restricted')
    server.setIdentity(fixtureSession({ oid: 'unassigned-account' }))
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    await page.waitForFunction(() =>
      document.body.textContent?.includes('You cannot open this portal')
    )
    delayed.release()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await page.$('sup a')).toBeNull()
    expect(await page.evaluate(() => document.body.textContent)).not.toContain(
      'Obsolete private question',
    )
    expect(server.requests.filter((r) => r.method === 'PUT' && r.path.includes('/sessions/')))
      .toEqual([])
    expect(server.requests.filter((r) => r.path.endsWith('/followups'))).toEqual([])
  } finally {
    delayed.release()
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('analyst deep dispatch works and pending advisory is retired across A-to-new-to-A', async () => {
  const generationCalls: string[] = []
  const management = {
    rephrase: () => Promise.resolve(null),
    resourceExtraction: () =>
      Promise.resolve({
        text:
          'Surveys across the southern region recorded a sustained 12% decline in abalone populations since 2019, with marine heatwaves identified as the leading stressor.',
        chars: 156,
        paragraphs: 1,
      }),
    askStructured: (_config: unknown, schema: { name: string }) => {
      generationCalls.push(schema.name)
      return Promise.resolve({
        object: {
          questions: schema.name === 'follow_up_questions'
            ? [{
              question: 'Which stressor leads the observed decline?',
              evidence:
                'Surveys across the southern region recorded a sustained 12% decline in abalone populations since 2019, with marine heatwaves identified as the leading stressor.',
            }]
            : ['How does temperature affect spawning?'],
        },
      })
    },
  } as unknown as BuildAppOptions['management']
  const server = startTestServer({ identity: { role: 'analyst' }, management })
  const delayed = server.delayResponse('/api/t/marine/followups')
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/ask`)
  try {
    await page.waitForSelector('#ask-composer')
    await clickText(page, 'Deep research')
    await ask(page)
    await entered(delayed.entered).catch(async (error) => {
      console.log(JSON.stringify(server.requests))
      console.log(await page.evaluate(() => document.body.textContent))
      throw error
    })
    await page.waitForSelector('sup a')
    expect(server.requests.some((r) => r.path.endsWith('/subqueries') && r.status === 200)).toBe(
      true,
    )
    expect(generationCalls).toContain('follow_up_questions')
    await clickText(page, '+ New session')
    await page.evaluate(() =>
      [...document.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('What affects abalone populations?')
      )!.click()
    )
    await page.waitForSelector('sup a')
    delayed.release()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await page.$('[aria-labelledby$="-followups"]')).toBeNull()
    expect(await page.evaluate(() => document.body.textContent)).not.toContain('Show the pipeline')
    server.setIdentity(fixtureSession({ oid: 'fixture-viewer' }))
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    await page.waitForFunction(() => !document.body.textContent?.includes('Deep research'))
    expect(await page.$('sup a')).toBeNull()
  } finally {
    delayed.release()
    await page.close()
    await browser.close()
    await server.close()
  }
})

for (const role of ['anonymous', 'viewer', 'analyst'] as const) {
  Deno.test(`${role} completes and restores a cited answer with exact enhancement authority`, async () => {
    const server = startTestServer(role === 'anonymous' ? {} : { identity: { role } })
    const browser = await launch()
    const page = await browser.newPage(`${server.url}/t/marine/ask`)
    try {
      await ask(page)
      await page.waitForSelector('sup a')
      await page.waitForFunction(() => document.body.textContent?.includes('Answer complete'))
      // Cover the trailing stream and debounced trail persistence, not merely its first citation.
      await new Promise((resolve) => setTimeout(resolve, 2000))
      expect(await page.$('sup a')).not.toBeNull()
      expect(
        server.requests.some((r) =>
          r.method === 'PUT' && r.path.includes('/sessions/') && r.status === 200
        ),
      ).toBe(true)
      const generated = () =>
        server.requests.filter((r) =>
          /\/(verdicts|followups|subqueries|summarize|generate)$/.test(r.path)
        )
      if (role === 'analyst') {
        expect(generated().some((r) => r.path.endsWith('/followups') && r.status === 200)).toBe(
          true,
        )
      } else {
        expect(generated()).toEqual([])
        expect(await page.evaluate(() => document.body.textContent)).not.toContain('Deep research')
      }
      await assertCurrentBuild(page)
      for (const scheme of ['light', 'dark']) {
        server.tenants.patchBranding('marine', {
          paletteId: scheme === 'dark' ? 'observatory' : 'default',
          shape: scheme === 'dark' ? 'soft' : 'square',
          density: 'comfortable',
          typography: 'lexend-zilla',
        })
        await page.evaluate((scheme) => {
          localStorage.setItem('rp-scheme', scheme)
          document.documentElement.dataset.scheme = scheme
        }, { args: [scheme] })
        // Restore via the real server on reload, then open the saved session.
        await page.goto(`${server.url}/t/marine/ask`)
        await page.waitForFunction(() =>
          [...document.querySelectorAll('button')].some((b) =>
            b.textContent?.includes('What affects abalone populations?')
          )
        )
        await page.evaluate(() =>
          [...document.querySelectorAll('button')].find((b) =>
            b.textContent?.includes('What affects abalone populations?')
          )!.click()
        )
        await page.waitForSelector('sup a')
        await page.waitForFunction(() =>
          [...document.querySelectorAll('.rp-answer-in, .rp-answer-tail')].every((e) =>
            Number(getComputedStyle(e).opacity) >= 0.999
          )
        )
        for (const width of [1440, 390]) {
          await captureBoundary(
            page,
            '.planning/logs/04-10-02/ask',
            `${role}-${scheme}-${width}`,
            width,
          )
        }
      }
      if (role !== 'analyst') expect(generated()).toEqual([])
      expect(server.requests.filter((r) => r.status === 401 || r.status === 403)).toEqual([])
    } finally {
      await page.close()
      await browser.close()
      await server.close()
    }
  })
}
