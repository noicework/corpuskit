import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import type { AskEvent, TenantConfig } from '@research-portal/core'
import { startTestServer } from './support/test-server.ts'
import { DoubleProvider } from './support/double-provider.ts'
import { assertCurrentBuild, captureBoundary } from './support/rbac-fixture.ts'

class EvaluationProvider extends DoubleProvider {
  override async *ask(tenant: TenantConfig, query: string): AsyncIterable<AskEvent> {
    if (query.includes('lunar')) {
      yield { type: 'done', refused: true, text: 'The corpus cannot answer this question.' }
      return
    }
    yield* super.ask(tenant, query)
  }
  override search(tenant: TenantConfig, query: string) {
    if (query.includes('lunar')) {
      return Promise.resolve({ query, resources: [], relatedQuestions: [] })
    }
    return super.search(tenant, query)
  }
}
async function fill(page: Page, selector: string, value: string) {
  await page.evaluate(({ selector, value }) => {
    const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!
    Object.getOwnPropertyDescriptor(
      field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      'value',
    )!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  }, { args: [{ selector, value }] })
}
async function activate(page: Page, text: string) {
  await page.waitForFunction((text: string) =>
    [...document.querySelectorAll('button')]
      .some((button) => button.textContent?.trim() === text && !button.disabled), { args: [text] })
  await page.evaluate((text) =>
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === text)!.focus(), { args: [text] })
  await page.keyboard.press('Enter')
}

Deno.test('Manage defines, confirms, runs and compares a portal evaluation set with CSV and accessible layouts', async () => {
  const server = startTestServer({
    identity: { role: 'portal-admin' },
    provider: new EvaluationProvider(),
  })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/manage?tab=evaluations`)
  try {
    await page.waitForSelector('[data-evaluations]')
    await assertCurrentBuild(page)
    await fill(page, '[name=evaluation-name]', 'Fisheries evidence checks')
    await fill(page, '[name=question-0]', 'What evidence describes abalone populations?')
    await fill(page, '[name=sources-0]', 'res-1')
    await activate(page, 'Add question')
    await fill(page, '[name=question-1]', 'What does the corpus say about lunar recipes?')
    await page.evaluate(() =>
      document.querySelectorAll<HTMLInputElement>('[data-evaluations] input[type=checkbox]')[1]!
        .click()
    )
    await activate(page, 'Save evaluation set')
    await page.waitForFunction(() =>
      document.querySelector('[data-evaluations] [role=status]')?.textContent?.includes('saved')
    )
    const before = server.providerCalls.filter((call) => call === 'ask').length
    await activate(page, 'Run saved set')
    await page.waitForSelector('[aria-label="Confirm evaluation run"]')
    expect(server.providerCalls.filter((call) => call === 'ask')).toHaveLength(before)
    await activate(page, 'Cancel run')
    expect(await page.$('[aria-label="Confirm evaluation run"]')).toBeNull()
    await activate(page, 'Run saved set')
    await activate(page, 'Confirm 2 asks')
    await page.waitForSelector('[data-evaluation-run]')
    const result = await page.evaluate(async () => {
      const listing = await (await fetch('/api/admin/t/marine/evaluations')).json()
      const set = listing.sets[0]
      const runs = await (await fetch(`/api/admin/t/marine/evaluations/${set.id}/runs`)).json()
      const csv = await fetch(`/api/admin/t/marine/evaluations/${set.id}/runs/${runs[0].id}/csv`)
      return { listing, runs, csv: await csv.text(), contentType: csv.headers.get('content-type') }
    })
    expect(result.listing.asksToday).toBe(2)
    expect(result.runs[0].status).toBe('completed')
    expect(result.runs[0].summary.retrievalHitRate).toBe(1)
    expect(result.runs[0].summary.declineCorrectness).toBe(1)
    expect(result.runs[0].summary.groundedness).toBe(4.5)
    expect(result.contentType).toContain('text/csv')
    expect(result.csv).toContain('Fisheries evidence checks')
    await activate(page, 'Run saved set')
    await activate(page, 'Confirm 2 asks')
    await page.waitForFunction(() =>
      document.querySelectorAll('[data-evaluation-run]').length === 2
    )
    expect(await page.evaluate(() => document.querySelector('[data-evaluation-runs]')!.textContent))
      .toContain('Previous run retrieval')
    await page.evaluate(() => {
      const select = [...document.querySelectorAll<HTMLSelectElement>('[data-evaluations] select')]
        .at(-1)!
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, '1')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await activate(page, 'Confirm schedule: up to 2 asks per run')
    await page.waitForFunction(() =>
      document.querySelector('[data-evaluations] [role=status]')?.textContent?.includes(
        'Schedule confirmed',
      )
    )
    // Verify the new panel and its surrounding Manage chrome in the real rendered themes.
    for (const scheme of ['light', 'dark']) {
      server.tenants.patchBranding('marine', {
        paletteId: scheme === 'dark' ? 'observatory' : 'default',
        shape: 'soft',
        density: 'spacious',
        typography: 'lexend-zilla',
      })
      await page.evaluate((scheme) => localStorage.setItem('rp-scheme', scheme), { args: [scheme] })
      await page.goto(`${server.url}/t/marine/manage?tab=evaluations`)
      await page.waitForSelector('[data-evaluations]')
      await page.waitForFunction(() =>
        document.querySelectorAll('[data-evaluations] option').length > 1
      )
      await page.evaluate(() => {
        const select = document.querySelector<HTMLSelectElement>('[data-evaluations] select')!
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(
          select,
          select.options[1]!.value,
        )
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await page.waitForSelector('[data-evaluation-run]')
      for (const width of [1440, 390, 320]) {
        await captureBoundary(
          page,
          '.planning/logs/eval-runner',
          `evaluations-${scheme}-${width}`,
          width,
        )
        for (
          const [surface, selector] of [['definition', '[data-evaluations]'], [
            'results',
            '[data-evaluation-runs]',
          ]]
        ) {
          await page.evaluate((selector) => {
            document.querySelector(selector!)!.scrollIntoView({
              block: 'start',
              behavior: 'instant',
            })
            const header = document.querySelector('header')!.getBoundingClientRect().height
            scrollBy(0, -header - 16)
          }, { args: [selector] })
          await Deno.writeFile(
            `.planning/logs/eval-runner/evaluations-${surface}-${scheme}-${width}.png`,
            await page.screenshot(),
          )
        }
        const styles = await page.evaluate(() => {
          const input = document.querySelector('[name=evaluation-name]')!
          const theme = getComputedStyle(input)
          return {
            radius: theme.borderRadius,
            expected: theme.getPropertyValue('--rp-radius-input').trim(),
            labelled: [
              ...document.querySelectorAll(
                '[data-evaluations] input,[data-evaluations] textarea,[data-evaluations] select',
              ),
            ]
              .every((element) => !!element.closest('label')),
          }
        })
        expect(styles.labelled).toBe(true)
        expect(styles.radius).not.toBe('0px')
        if (width === 320) {
          const spacing = await page.evaluate(() => {
            const panel = document.querySelector<HTMLElement>('[data-evaluations]')!
            panel.style.lineHeight = '1.5'
            panel.style.letterSpacing = '0.12em'
            panel.style.wordSpacing = '0.16em'
            for (const p of panel.querySelectorAll<HTMLElement>('p')) p.style.marginBottom = '2em'
            return {
              overflow: document.documentElement.scrollWidth - innerWidth,
              buttonsFit: [...panel.querySelectorAll('button')].every((button) => {
                const box = button.getBoundingClientRect()
                const parent = (button.closest('article') ?? panel).getBoundingClientRect()
                return box.right <= parent.right && box.left >= parent.left
              }),
            }
          })
          expect(spacing.overflow).toBeLessThanOrEqual(1)
          expect(spacing.buttonsFit).toBe(true)
          await page.evaluate(() => {
            const panel = document.querySelector<HTMLElement>('[data-evaluations]')!
            panel.style.lineHeight = ''
            panel.style.letterSpacing = ''
            panel.style.wordSpacing = ''
            for (const p of panel.querySelectorAll<HTMLElement>('p')) p.style.marginBottom = ''
          })
        }
      }
    }
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})
