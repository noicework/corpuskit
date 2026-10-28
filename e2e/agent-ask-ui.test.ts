// The agent ask page (apps/web/src/pages/AgentAskPage.tsx) in a real browser over the stub
// server: the fixture stream rendered end to end, a stopped stream, a failed one, a composed
// answer naming a partner that failed, and the page's accessibility contract.
import { afterAll, beforeAll, describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { type Browser, launch, type Page } from '@astral/astral'
import {
  AGENT_STUB_PORTAL,
  type AgentStubServer,
  startAgentStub,
} from './support/agent-stub-server.ts'

let browser: Browser
/** Replays without waiting: the whole happy path lands at once. */
let instant: AgentStubServer
/** Replays at the recorded pace, for watching a stream run and stopping it. */
let paced: AgentStubServer

beforeAll(async () => {
  instant = await startAgentStub({ speed: 0 })
  paced = await startAgentStub({ speed: 1, apiOnly: false })
  browser = await launch()
})

afterAll(async () => {
  await browser.close()
  await instant.close()
  await paced.close()
})

function agentUrl(server: AgentStubServer, question: string, run = true): string {
  const params = new URLSearchParams({ q: question })
  if (run) params.set('run', '1')
  return `${server.url}/t/${AGENT_STUB_PORTAL}/agent?${params}`
}

async function settle(page: Page, probe: () => boolean, what: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await page.evaluate(probe)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`${what} did not settle in time`)
}

describe('agent ask page', () => {
  it('renders the fixture stream end to end: steps, sources per collection, reasoning and a cited answer', async () => {
    const page = await browser.newPage(agentUrl(instant, 'How is warming changing pests? #fast'))
    try {
      await page.waitForSelector('[data-agent-answer]')
      await settle(
        page,
        () => document.querySelector<HTMLElement>('[data-agent-answer]')?.dataset.status === 'done',
        'the answer',
      )
      const seen = await page.evaluate(() => {
        const text = (selector: string) =>
          Array.from(document.querySelectorAll<HTMLElement>(selector)).map((el) =>
            el.innerText.replace(/\s+/g, ' ').trim()
          )
        return {
          title: document.title,
          heading: document.querySelector('h1')?.textContent,
          mode: document.querySelector('[data-agent-mode]')?.textContent,
          steps: document.querySelectorAll('[data-agent-steps] li[data-step-status]').length,
          stepStatuses: new Set(
            Array.from(document.querySelectorAll<HTMLElement>('[data-agent-steps] li'))
              .map((li) => li.dataset.stepStatus),
          ).size,
          sources: Array.from(
            document.querySelectorAll<HTMLElement>('[data-agent-sources] li[data-source-id]'),
          )
            .map((
              li,
            ) => [
              li.dataset.sourceId,
              li.dataset.sourceState,
              li.querySelectorAll('.rp-agent-passage').length,
            ]),
          markers: text('[data-agent-text] sup'),
          markerLinks: document.querySelectorAll('[data-agent-text] sup a[href]').length,
          citations: document.querySelectorAll('[data-agent-citations] li li').length,
          reasoning: document.querySelector('[aria-controls="agent-reasoning"]')?.textContent
            ?.replace(/\s+/g, ' ').trim(),
          reasoningToggle: document.querySelector('[aria-controls="agent-reasoning"]')
            ?.getAttribute('aria-expanded'),
          status: text('[data-agent-page] [role=status]'),
          failed: document.querySelector('[data-agent-failed-sources]') !== null,
          clock: document.querySelector('[data-agent-clock]')?.textContent?.trim(),
          query: new URLSearchParams(location.search).get('q'),
          run: new URLSearchParams(location.search).get('run'),
        }
      })
      expect(seen.title).toBe('Agent ask | Southern Waters Research Portal')
      expect(seen.heading).toBe('How is warming changing pests? #fast')
      expect(seen.mode).toBe("Answered by the portal's research agent")
      expect(seen.steps).toBe(12)
      expect(seen.stepStatuses).toBe(1)
      expect(seen.sources).toEqual([
        ['drv-fisheries', 'found', 3],
        ['drv-grains', 'found', 3],
        ['drv-rural', 'found', 4],
      ])
      expect(seen.markers).toEqual(['1', '2', '3', '4', '5', '6'])
      expect(seen.markerLinks).toBe(6)
      expect(seen.citations).toBe(6)
      // The working notes are there but closed until the reader asks for them.
      expect(seen.reasoning).toMatch(/^Show working\s*3 notes$/)
      expect(seen.reasoningToggle).toBe('false')
      expect(seen.failed).toBe(false)
      expect(seen.clock).toBe('Answered in 1 min 30 s')
      // One announcement for the whole answer, not one a chunk.
      expect(seen.status).toEqual(['Answer finished: 6 citations from 3 collections.'])
      // `run` is consumed; `q` stays so the address names the question.
      expect(seen.query).toBe('How is warming changing pests? #fast')
      expect(seen.run).toBeNull()
    } finally {
      await page.close()
    }
  })

  it('composes across the host and its partners and names the partner that failed', async () => {
    const page = await browser.newPage(agentUrl(instant, 'Why? #compose #peer-unauthorised #fast'))
    try {
      await page.waitForSelector('[data-agent-answer]')
      await settle(
        page,
        () => document.querySelector<HTMLElement>('[data-agent-answer]')?.dataset.status === 'done',
        'the composed answer',
      )
      const seen = await page.evaluate(() => ({
        mode: document.querySelector('[data-agent-mode]')?.textContent,
        notice: document.querySelector<HTMLElement>('[data-agent-failed-sources]')?.innerText
          .replace(/\s+/g, ' ').trim(),
        sources: Array.from(
          document.querySelectorAll<HTMLElement>('[data-agent-sources] li[data-source-id]'),
        )
          .map((li) => [li.dataset.sourceId, li.dataset.sourceState]),
        partnerLabels: Array.from(
          document.querySelectorAll<HTMLElement>('[data-agent-sources] [data-source-kind]'),
        ).map((p) => p.textContent),

        // A partner's passages carry no link, by the partner's choice.
        partnerLinks: document.querySelectorAll('[data-source-id="peer:soil-partner"] a').length,
        hostLinks: Array.from(
          document.querySelectorAll<HTMLAnchorElement>('[data-source-id="marine"] a'),
        )
          .map((a) => a.getAttribute('href')),
        unlinkedChips: document.querySelectorAll('[data-agent-citations] span.rp-chip').length,
        status: Array.from(document.querySelectorAll('[data-agent-page] [role=status]')).map((el) =>
          el.textContent?.trim()
        ),
      }))
      expect(seen.mode).toBe('Composed by CorpusKit from 2 collections')
      expect(seen.notice).toBe(
        'Water partner collection could not be reached. The answer uses the collections that responded, so it may leave out research held only in Water partner collection.',
      )
      expect(seen.sources).toEqual([
        ['marine', 'found'],
        ['peer:soil-partner', 'found'],
        ['peer:water-partner', 'failed'],
      ])
      expect(seen.partnerLabels).toEqual(['federated partner', 'partner over MCP'])
      expect(seen.partnerLinks).toBe(0)
      expect(seen.hostLinks.every((href) => href?.startsWith('/t/marine/library/'))).toBe(true)
      expect(seen.unlinkedChips).toBeGreaterThan(0)
      expect(seen.status).toEqual(['Answer finished: 5 citations from 2 collections.'])
    } finally {
      await page.close()
    }
  })

  it('keeps what arrived when the agent fails, and offers to try again', async () => {
    const page = await browser.newPage(agentUrl(instant, 'Why? #error #fast'))
    try {
      await page.waitForSelector('[data-agent-answer]')
      await settle(
        page,
        () =>
          document.querySelector<HTMLElement>('[data-agent-answer]')?.dataset.status === 'error',
        'the error',
      )
      const seen = await page.evaluate(() => ({
        alert: document.querySelector<HTMLElement>('[role=alert]')?.innerText.replace(/\s+/g, ' ')
          .trim(),
        retry: document.querySelector<HTMLButtonElement>('[role=alert] button')?.textContent
          ?.trim(),
        failedSteps:
          document.querySelectorAll('[data-agent-steps] li[data-step-status="failed"]').length,
        sources: Array.from(
          document.querySelectorAll<HTMLElement>('[data-agent-sources] li[data-source-id]'),
        )
          .map((li) => li.dataset.sourceState),
      }))
      expect(seen.alert).toContain('The answer could not be finished')
      expect(seen.retry).toBe('Try again')
      expect(seen.failedSteps).toBe(2)
      // The passages the first collection returned before the failure are still there.
      expect(seen.sources).toEqual(['found', 'queued', 'queued'])
    } finally {
      await page.close()
    }
  })

  it('stops on request, keeping the steps so far, without moving the focus', async () => {
    const page = await browser.newPage(agentUrl(paced, 'Why?', false))
    try {
      await page.waitForSelector('[data-agent-submit]')
      await page.evaluate(() => {
        const submit = document.querySelector<HTMLButtonElement>('[data-agent-submit]')!
        submit.focus()
        submit.click()
      })
      await settle(
        page,
        () => document.querySelectorAll('[data-agent-steps] li[data-step-status]').length >= 1,
        'the first step',
      )
      expect(
        await page.evaluate(() => ({
          label: document.querySelector('[data-agent-submit]')?.textContent?.trim(),
          focused: document.activeElement?.hasAttribute('data-agent-submit'),
          status: document.querySelector<HTMLElement>('[data-agent-answer]')?.dataset.status,
        })),
      ).toEqual({ label: 'Stop', focused: true, status: 'streaming' })
      await page.evaluate(() =>
        document.querySelector<HTMLButtonElement>('[data-agent-submit]')!.click()
      )
      await settle(
        page,
        () =>
          document.querySelector<HTMLElement>('[data-agent-answer]')?.dataset.status ===
            'cancelled',
        'the stop',
      )
      const seen = await page.evaluate(() => ({
        label: document.querySelector('[data-agent-submit]')?.textContent?.trim(),
        focused: document.activeElement?.hasAttribute('data-agent-submit'),
        steps: document.querySelectorAll('[data-agent-steps] li[data-step-status]').length,
        notice: document.querySelector<HTMLElement>('[data-agent-cancelled]')?.innerText.replace(
          /\s+/g,
          ' ',
        ).trim(),
      }))
      expect(seen.label).toBe('Send')
      expect(seen.focused).toBe(true)
      expect(seen.steps).toBeGreaterThanOrEqual(1)
      expect(seen.notice).toContain('Stopped')
      expect(paced.provider.agentAsksOpen).toBe(0)
    } finally {
      await page.close()
    }
  })

  it('keeps a running answer through the remount a return to the window causes', async () => {
    const page = await browser.newPage(agentUrl(paced, 'Why?', true))
    try {
      await page.waitForSelector('[data-agent-answer]')
      await settle(
        page,
        () => document.querySelectorAll('[data-agent-steps] li[data-step-status]').length >= 1,
        'the first step',
      )
      const before = await page.evaluate(() => ({
        status: document.querySelector<HTMLElement>('[data-agent-answer]')?.dataset.status,
        steps: document.querySelectorAll('[data-agent-steps] li[data-step-status]').length,
      }))
      expect(before.status).toBe('streaming')
      // A return to the window: the access layer withdraws authority, re-reads the session and
      // remounts the page. The run must still be there when the page comes back.
      await page.evaluate(() => {
        globalThis.dispatchEvent(new Event('blur'))
        globalThis.dispatchEvent(new Event('focus'))
      })
      await settle(
        page,
        () =>
          document.querySelector('[data-access-state]') === null &&
          document.querySelector('[data-agent-answer]') !== null,
        'the page to come back',
      )
      const after = await page.evaluate(() => ({
        status: document.querySelector<HTMLElement>('[data-agent-answer]')?.dataset.status,
        steps: document.querySelectorAll('[data-agent-steps] li[data-step-status]').length,
        question: document.querySelector('h1')?.textContent,
      }))
      expect(after.status).toBe('streaming')
      expect(after.steps).toBeGreaterThanOrEqual(before.steps)
      expect(after.question).toBe('Why?')
      // And the stream is still being read: more steps arrive after the remount.
      await settle(
        page,
        () => document.querySelectorAll('[data-agent-steps] li[data-step-status]').length >= 4,
        'steps after the remount',
        20_000,
      )
      await page.evaluate(() =>
        document.querySelector<HTMLButtonElement>('[data-agent-submit]')!.click()
      )
      await settle(
        page,
        () =>
          document.querySelector<HTMLElement>('[data-agent-answer]')?.dataset.status ===
            'cancelled',
        'the stop',
      )
    } finally {
      await page.close()
    }
  })

  it('is keyboard reachable with comfortable targets and no sideways scroll on a narrow phone', async () => {
    const page = await browser.newPage(agentUrl(instant, 'How is warming changing pests? #fast'))
    try {
      await page.setViewportSize({ width: 320, height: 640 })
      await page.waitForSelector('[data-agent-answer]')
      await settle(
        page,
        () => document.querySelector<HTMLElement>('[data-agent-answer]')?.dataset.status === 'done',
        'the answer',
      )
      const seen = await page.evaluate(() => {
        const controls = Array.from(
          document.querySelectorAll<HTMLElement>(
            '[data-agent-page] button, [data-agent-page] a, [data-agent-page] textarea',
          ),
        ).filter((el) => el.getClientRects().length > 0)
        const small = controls
          // Inline links are exempt: a marker in the prose, and a passage title whose
          // open line below it is the comfortable target for the same document.
          .filter((el) =>
            el.tagName !== 'A' ||
            (!el.closest('sup') && !el.classList.contains('rp-answer-source-title'))
          )
          .map((el) => ({
            text: (el.textContent ?? '').trim().slice(0, 30),
            height: el.getBoundingClientRect().height,
          }))
          .filter((item) => item.height < 44)
        const label = document.querySelector('label[for="agent-question"]')
        return {
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: innerWidth,
          small,
          labelled: label !== null && (label.textContent ?? '').trim().length > 0,
          describedBy: document.getElementById('agent-question')?.getAttribute('aria-describedby'),
          unreachable: controls.filter((el) => el.tabIndex < 0 && el.tagName !== 'A').length,
          expandedControls: Array.from(
            document.querySelectorAll('[data-agent-page] [aria-expanded]'),
          ).every((el) => document.getElementById(el.getAttribute('aria-controls') ?? '') !== null),
          liveRegions: document.querySelectorAll('[data-agent-page] [aria-live]').length,
        }
      })
      expect(seen.scrollWidth).toBeLessThanOrEqual(seen.innerWidth)
      expect(seen.small).toEqual([])
      expect(seen.labelled).toBe(true)
      expect(seen.describedBy).toBe('agent-question-hint')
      expect(seen.unreachable).toBe(0)
      expect(seen.expandedControls).toBe(true)
      expect(seen.liveRegions).toBe(1)
    } finally {
      await page.close()
    }
  })
})
