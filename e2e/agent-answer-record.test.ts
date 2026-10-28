import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import { AgentAskEventSchema, type AnswerRecord, AnswerRecordSchema } from '@research-portal/core'
import { startAgentStub } from './support/agent-stub-server.ts'
import { fixtureSession } from '../apps/api/src/rbac-integration-fixture.ts'
import { assertCurrentBuild } from './support/rbac-fixture.ts'

async function capture(page: Page, screen: string, width: number, scheme: string, textSize = 16) {
  await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 })
  await page.evaluate(async (textSize) => {
    document.documentElement.style.fontSize = `${textSize}px`
    await document.fonts.ready
  }, { args: [textSize] })
  const measured = await page.evaluate(() => ({
    width: innerWidth,
    overflow: document.documentElement.scrollWidth - innerWidth,
    outside: [...document.querySelectorAll('body *')].filter((e) =>
      e.getBoundingClientRect().right > innerWidth + 1
    ).slice(0, 8).map((e) => ({
      tag: e.tagName,
      text: e.textContent?.slice(0, 80),
      width: e.getBoundingClientRect().width,
      cls: e.className,
    })),
  }))
  expect(measured.width).toBe(width)
  if (measured.overflow > 1) throw new Error(JSON.stringify(measured))
  expect(measured.overflow).toBeLessThanOrEqual(1)
  await page.evaluate((screen) => {
    const target = screen.includes('text200')
      ? '[role="table"]'
      : screen.includes('passages')
      ? '[aria-label="Passages retrieved"]'
      : /sources|text200|reflow|spacing/.test(screen)
      ? '#agent-evidence'
      : 'main'
    const element = document.querySelector(target)!
    scrollTo(
      0,
      scrollY + element.getBoundingClientRect().top -
        (document.querySelector('header')?.getBoundingClientRect().height ?? 180) - 16,
    )
  }, { args: [screen] })
  await Deno.mkdir('.review/agent-records', { recursive: true })
  await Deno.writeFile(
    `.review/agent-records/${screen}-${width}-${scheme}.png`,
    await page.screenshot(),
  )
}

Deno.test('agent stub answers persist and a curator opens, reviews and exports their federated evidence', async () => {
  const server = await startAgentStub({ speed: 0 })
  server.setAssignment({ kind: 'portal', slug: 'marine' }, 'fixture-record-curator', 'curator')
  server.setIdentity(fixtureSession({ oid: 'fixture-record-curator' }))
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine`)
  try {
    let composedId = ''
    let agentId = ''
    let composedRecord: AnswerRecord | undefined
    for (
      const query of [
        'How is warming changing pests? #fast',
        'How is warming changing pests? #compose #peer-unauthorised #fast',
      ]
    ) {
      const response = await fetch(`${server.url}/api/t/marine/ask-agent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
      })
      expect(response.status).toBe(200)
      const events = (await response.text()).split('\n').filter((s) => s.startsWith('data: ')).map((
        s,
      ) => AgentAskEventSchema.parse(JSON.parse(s.slice(6))))
      expect(events.at(-1)?.type).toBe('done')
      const saved = events.at(-2)
      expect(saved?.type).toBe('answer-record')
      if (saved?.type !== 'answer-record') throw new Error('Missing answer record')
      const detail = await fetch(
        `${server.url}/api/admin/t/marine/answer-records/records/${saved.answerId}`,
      )
      expect(detail.status).toBe(200)
      const record = AnswerRecordSchema.parse(await detail.json())
      expect(record.agent?.mode).toBe(query.includes('#compose') ? 'orchestrated' : 'agent')
      expect(record.retrieved.length).toBeGreaterThan(0)
      if (query.includes('#compose')) {
        composedId = saved.answerId
        composedRecord = record
      } else agentId = saved.answerId
    }
    await page.goto(`${server.url}/t/marine/answer-records/${agentId}`)
    await page.waitForSelector('#agent-evidence')
    const agentText = await page.evaluate(() => document.querySelector('main')!.innerText)
    expect(agentText).toContain('Mode: Answered by the agent')
    expect(agentText).toContain('Answered by the agent · Answered')
    expect(agentText).not.toContain('Unknown')
    expect(agentText).not.toContain('Page:')
    expect(agentText).not.toContain('Score:')
    expect(agentText).not.toContain('Citations dropped:')
    expect(agentText.match(/This source does not report rejected citations\./g)).toHaveLength(1)
    expect(
      await page.evaluate(() =>
        document.querySelector('#verification')!.parentElement!
          .querySelector('pre')!.textContent
      ),
    ).not.toContain('null')
    const path = `/t/marine/answer-records/${composedId}`
    await page.goto(`${server.url}${path}`)
    await page.waitForSelector('#agent-evidence')
    await assertCurrentBuild(page)
    const text = await page.evaluate(() => document.body.innerText)
    for (
      const value of [
        'Mode: Composed by the portal',
        'Composed by the portal · Answered',
        'Soil partner collection',
        'Water partner collection',
        'Hosted collection',
        'Partner collection',
        'Knowledge box search',
        'MCP server',
        'unauthorised',
        'Citation decisions',
      ]
    ) expect(text).toContain(value)
    expect(text).not.toContain('Unknown')
    const passageText = await page.evaluate(() =>
      document.querySelector<HTMLElement>('[aria-label="Passages retrieved"]')!.innerText
    )
    const passageStep = composedRecord!.agent!.steps.find((step) =>
      step.id === composedRecord!.retrieved[0]!.stepId
    )!
    expect(passageText).toContain(`Step: ${passageStep.title}`)
    expect(passageText).not.toContain(`Step: ${passageStep.id}`)
    await page.evaluate(() =>
      document.querySelector<HTMLElement>('#agent-evidence')!.parentElement!
        .querySelector('summary')!.focus()
    )
    await page.keyboard.press('Enter')
    expect(await page.evaluate(() => document.querySelector('main')!.innerText)).toContain(
      composedRecord!.agent!.steps[0]!.id,
    )
    await page.evaluate(() => {
      const blobs: Blob[] = [], names: string[] = []
      Object.assign(globalThis, { agentRecordDownloads: { blobs, names } })
      const create = URL.createObjectURL
      URL.createObjectURL = (blob) => {
        blobs.push(blob as Blob)
        return create(blob)
      }
      const click = HTMLAnchorElement.prototype.click
      HTMLAnchorElement.prototype.click = function () {
        if (this.download) {
          names.push(this.download)
          return
        }
        click.call(this)
      }
    })
    for (const format of ['JSON', 'CSV']) {
      const label = `Export record ${format}`
      await page.evaluate(
        (label) =>
          [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!
            .focus(),
        { args: [label] },
      )
      await page.keyboard.press('Enter')
      await page.waitForFunction(
        (format) =>
          (globalThis as unknown as { agentRecordDownloads: { names: string[] } })
            .agentRecordDownloads.names.some((name) => name.endsWith(`.${format.toLowerCase()}`)),
        { args: [format] },
      )
    }
    const downloads = await page.evaluate(async () =>
      Promise.all(
        (globalThis as unknown as { agentRecordDownloads: { blobs: Blob[] } }).agentRecordDownloads
          .blobs.map((b) => b.text()),
      )
    )
    const exported = AnswerRecordSchema.parse(JSON.parse(downloads[0]!)[0])
    expect(exported).toEqual(composedRecord)
    const rawCsv = await fetch(
      `${server.url}/api/admin/t/marine/answer-records/records/${composedId}/export?format=csv`,
    )
    expect(rawCsv.status).toBe(200)
    expect(downloads[1]).toBe(await rawCsv.text())
    expect(exported.answerId).toBe(composedId)
    expect(exported.agent?.sources.map((s) => [s.kind, s.transport])).toEqual([['hosted', 'kb'], [
      'peer',
      'kb',
    ], ['peer', 'mcp']])
    expect(exported.agent?.failedSources).toEqual([{
      sourceId: 'peer:water-partner',
      reason: 'unauthorised',
    }])
    expect(exported.agent?.citationDecisions.some((d) => d.outcome === 'kept')).toBe(true)
    expect(downloads[1]).toContain('"sources"')
    expect(downloads[1]).toContain('""transport"":""mcp""')
    expect(downloads.join('')).not.toContain('stub-peer-key-')
    for (const scheme of ['light', 'dark']) {
      server.tenants.patchBranding('marine', {
        paletteId: scheme === 'dark' ? 'observatory' : 'default',
        shape: 'soft',
        density: 'spacious',
        typography: 'lexend-zilla',
        organisation: 'Fisheries research',
      })
      await page.evaluate((scheme) => localStorage.setItem('rp-scheme', scheme), { args: [scheme] })
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
      await page.goto(`${server.url}${path}`)
      await page.waitForSelector('#agent-evidence')
      for (const width of [1440, 390]) {
        await capture(page, 'agent-record', width, scheme)
        await page.evaluate(() => {
          document.querySelector('#agent-evidence')!.scrollIntoView()
          scrollBy(0, -180)
        })
        await capture(page, 'agent-record-sources', width, scheme)
        await page.evaluate(() => {
          document.querySelector('[aria-label="Passages retrieved"]')!.scrollIntoView()
          scrollBy(0, -180)
        })
        await capture(page, 'agent-record-passages', width, scheme)
        await page.evaluate(() => scrollTo(0, 0))
      }
      await page.evaluate(() => {
        document.querySelector('#agent-evidence')!.scrollIntoView()
        scrollBy(0, -180)
      })
      await capture(page, 'agent-record-text200', 390, scheme, 32)
      await capture(page, 'agent-record-reflow', 320, scheme, 16)
      // WCAG text spacing overrides must preserve the actual layout viewport.
      await page.evaluate(() => {
        const style = document.createElement('style')
        style.id = 'record-text-spacing'
        style.textContent =
          'main * { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } main p { margin-bottom: 2em !important; }'
        document.head.append(style)
      })
      await capture(page, 'agent-record-spacing', 320, scheme, 16)
      await page.evaluate(() => {
        document.querySelector('#record-text-spacing')?.remove()
        scrollTo(0, 0)
      })
    }
    server.setIdentity(fixtureSession({ oid: 'fixture-viewer' }))
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    await page.waitForFunction(() => !document.querySelector('#record-question'))
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})
