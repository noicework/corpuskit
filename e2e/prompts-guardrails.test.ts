import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import type { AskEvent, TenantConfig } from '@research-portal/core'
import { AnswerGuardrailsSchema } from '@research-portal/core'
import type { AskOptions, ComposePassage } from '../packages/retrieval/src/provider.ts'
import { DoubleProvider } from './support/double-provider.ts'
import { startTestServer } from './support/test-server.ts'
import { assertCurrentBuild } from './support/rbac-fixture.ts'

class PolicyDouble extends DoubleProvider {
  instructions: { slug: string; text?: string }[] = []
  override async *ask(
    tenant: TenantConfig,
    query: string,
    opts?: AskOptions,
  ): AsyncIterable<AskEvent> {
    this.instructions.push({ slug: tenant.slug, text: opts?.answerInstructions })
    yield* super.ask(tenant, query)
  }
  override compose(
    tenant: TenantConfig,
    query: string,
    passages: readonly ComposePassage[],
    opts?: { answerInstructions?: string },
  ) {
    this.instructions.push({ slug: tenant.slug, text: opts?.answerInstructions })
    return super.compose(tenant, query, passages)
  }
}

async function fill(page: Page, selector: string, value: string) {
  await page.evaluate((selector, value) => {
    const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!
    Object.getOwnPropertyDescriptor(
      input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, { args: [selector, value] })
}

async function save(page: Page) {
  await page.evaluate(() =>
    document.querySelector<HTMLButtonElement>('[data-behaviour-save]')!.click()
  )
  await page.waitForFunction(() =>
    document.body.innerText.includes('Saved - the new prompt applies')
  )
}

async function submitAsk(page: Page, query: string) {
  await page.waitForSelector('#ask-composer')
  await fill(page, '#ask-composer', query)
  await page.waitForFunction(() =>
    !document.querySelector('#ask-composer')!.closest('form')!.querySelector<HTMLButtonElement>(
      'button[type=submit]',
    )!.disabled
  )
  await page.evaluate(() =>
    document.querySelector('#ask-composer')!.closest('form')!.requestSubmit()
  )
}

async function screenshot(
  page: Page,
  screen: string,
  width: number,
  scheme: string,
  selector: string,
  scale = false,
) {
  await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 })
  await page.evaluate(async (selector, scale) => {
    if (scale) document.documentElement.style.setProperty('font-size', '32px', 'important')
    else document.documentElement.style.removeProperty('font-size')
    await document.fonts.ready
    document.querySelector(selector)!.scrollIntoView({ block: 'start' })
    scrollBy(0, -160)
  }, { args: [selector, scale] })
  const dimensions = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
  }))
  expect(dimensions.width).toBe(width)
  expect(dimensions.scroll).toBeLessThanOrEqual(width + 1)
  await Deno.mkdir('.review/prompts-guardrails', { recursive: true })
  await Deno.writeFile(
    `.review/prompts-guardrails/${screen}${scale ? '-200pct' : ''}-${width}-${scheme}.png`,
    await page.screenshot(),
  )
}

Deno.test('Manage answer settings, refused and withheld answers, isolation, Insights, reset and responsive themes', async () => {
  const provider = new PolicyDouble()
  const server = startTestServer({ identity: { role: 'owner' }, provider })
  await server.bindings.set('marine', {
    baseUrl: 'https://research.example.test/api/v1/kb/fixture',
    token: 'fixture-only',
  })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/manage?tab=behaviour`)
  try {
    for (const slug of ['marine', 'grains']) {
      server.tenants.patchBranding(slug, {
        productName: slug === 'marine' ? 'Fisheries research' : 'Soil Research Hub',
        organisation: 'Example research team',
      })
    }
    await page.goto(`${server.url}/t/marine/manage?tab=behaviour`)
    await page.waitForSelector('[data-behaviour-prompt]:not(:disabled)')
    await assertCurrentBuild(page)
    await fill(page, '[data-behaviour-prompt]', 'Explain specialist terms.')
    await fill(page, '#policy-outOfScope', 'politics\n選挙')
    await fill(page, '#policy-blockedTerms', 'heatwaves')
    await fill(page, '#policy-refusal', 'Please ask about the research collection.')
    await fill(page, '#policy-withheld', 'The portal team has withheld this answer.')
    await fill(page, '#policy-contact', 'Contact: help@example.test')
    await fill(page, '#policy-length', '1000')
    await save(page)
    expect(server.tenants.promptsFor('marine').ask).toBe('Explain specialist terms.')
    expect(server.tenants.promptsFor('grains')).toEqual({})

    // Keyboard-operable reset, then re-enter the instructions before saving.
    await page.evaluate(() =>
      [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent?.trim() === 'Reset answer instructions'
      )!.focus()
    )
    await page.keyboard.press('Enter')
    expect(
      await page.evaluate(() =>
        document.querySelector<HTMLTextAreaElement>('[data-behaviour-prompt]')!.value
      ),
    ).toBe('')
    await fill(page, '[data-behaviour-prompt]', 'Explain specialist terms.')
    await save(page)

    await page.goto(`${server.url}/t/marine/ask`)
    const before = provider.instructions.length
    await submitAsk(page, 'Tell me about politics')
    await page.waitForFunction(() =>
      document.body.innerText.includes('Please ask about the research collection.')
    )
    expect(await page.evaluate(() => document.body.innerText)).toContain('help@example.test')
    expect(provider.instructions.length).toBe(before)

    await page.goto(`${server.url}/t/marine/ask`)
    await submitAsk(page, 'What affects abalone populations?')
    await page.waitForFunction(() =>
      document.body.innerText.includes('The portal team has withheld this answer.')
    )
    expect(await page.evaluate(() => document.body.innerText)).toContain('help@example.test')
    expect(
      provider.instructions.some((c) =>
        c.slug === 'marine' && c.text === 'Explain specialist terms.'
      ),
    ).toBe(true)

    // The same provider and question, through a different portal's actual answer pipeline.
    await page.goto(`${server.url}/t/grains/ask`)
    await submitAsk(page, 'What affects abalone populations?')
    await page.waitForFunction(() => document.body.innerText.includes('Marine heatwaves'))
    expect(await page.evaluate(() => document.body.innerText)).not.toContain(
      'The portal team has withheld',
    )
    expect(provider.instructions.some((c) => c.slug === 'grains' && c.text === undefined)).toBe(
      true,
    )

    for (const scheme of ['light', 'dark']) {
      server.tenants.patchBranding('marine', {
        paletteId: scheme === 'dark' ? 'observatory' : 'default',
        shape: 'soft',
        density: 'spacious',
        typography: 'lexend-zilla',
      })
      await page.evaluate((scheme) => localStorage.setItem('rp-scheme', scheme), { args: [scheme] })
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
      await page.goto(`${server.url}/t/marine/manage?tab=behaviour`)
      await page.waitForSelector('[data-behaviour-prompt]:not(:disabled)')
      for (const width of [1440, 390]) {
        await screenshot(page, 'behaviour-instructions', width, scheme, '[data-behaviour-prompt]')
        await screenshot(page, 'behaviour-guardrails', width, scheme, '#policy-outOfScope')
        await screenshot(page, 'behaviour-messages', width, scheme, '#policy-refusal')
      }
      await screenshot(page, 'behaviour-instructions', 390, scheme, '[data-behaviour-prompt]', true)
      await screenshot(page, 'behaviour-guardrails', 390, scheme, '#policy-outOfScope', true)
      await screenshot(page, 'behaviour-messages', 390, scheme, '#policy-refusal', true)
      await screenshot(page, 'behaviour-reflow', 320, scheme, '#policy-contact')
      await page.evaluate(() => document.documentElement.style.removeProperty('font-size'))
      await page.goto(`${server.url}/t/marine/manage?tab=insights`)
      await page.waitForSelector('[data-guardrail-counts]')
      const counts = await page.evaluate(() =>
        document.querySelector('[data-guardrail-counts]')!.textContent
      )
      expect(counts).toContain('Questions refused by policy1')
      expect(counts).toContain('Answers withheld for blocked terms1')
      for (const width of [1440, 390]) {
        await screenshot(page, 'insights', width, scheme, '[data-guardrail-counts]')
      }
      await screenshot(page, 'insights', 390, scheme, '[data-guardrail-counts]', true)
    }
    await page.evaluate(() => document.documentElement.style.removeProperty('font-size'))
    await page.goto(`${server.url}/t/marine/manage?tab=behaviour`)
    await page.waitForSelector('[data-behaviour-prompt]:not(:disabled)')
    await page.evaluate(() => {
      for (const text of ['Reset answer instructions', 'Reset guardrails']) {
        ;[...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
          b.textContent?.trim() === text
        )!.click()
      }
    })
    await save(page)
    expect(server.tenants.promptsFor('marine').ask).toBeUndefined()
    expect(server.tenants.promptsFor('marine').guardrails?.blockedTerms).toEqual([])
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('composed agent answers and length caps use the host policy over HTTP', async () => {
  const provider = new PolicyDouble()
  const server = startTestServer({ identity: { role: 'owner' }, provider })
  const post = async (slug: string, suffix: string, query: string) => {
    const response = await fetch(`${server.url}/api/t/${slug}/${suffix}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    })
    expect(response.status).toBe(200)
    return response.text()
  }
  try {
    for (const slug of ['marine', 'grains']) server.tenants.patch(slug, { agentAsk: true })
    server.tenants.patch('marine', {
      prompts: {
        ask: 'Explain specialist terms.',
        guardrails: AnswerGuardrailsSchema.parse({
          blockedTerms: ['heatwaves'],
          withheldMessage: 'Answer withheld by the host.',
          contactLine: 'Contact: help@example.test',
        }),
      },
    })
    const withheld = await post('marine', 'ask-agent', 'Stock health? #compose')
    expect(withheld).toContain('Answer withheld by the host.')
    expect(withheld).not.toContain('Surveys across')
    expect(provider.instructions).toContainEqual({
      slug: 'marine',
      text: 'Explain specialist terms.',
    })
    const other = await post('grains', 'ask-agent', 'Stock health? #compose')
    expect(other).toContain('Surveys across')
    expect(other).not.toContain('Answer withheld by the host.')
    expect(provider.instructions).toContainEqual({ slug: 'grains', text: undefined })
    server.tenants.patch('marine', {
      prompts: {
        guardrails: AnswerGuardrailsSchema.parse({
          maxAnswerLength: 100,
          withheldMessage: 'Answer exceeds the portal limit.',
        }),
      },
    })
    const capped = await post('marine', 'ask', 'What affects abalone populations?')
    expect(capped).toContain('Answer exceeds the portal limit.')
    expect(capped).not.toContain('Marine heatwaves')
    const summaryResponse = await fetch(`${server.url}/api/admin/t/marine/insights`)
    const summary = await summaryResponse.json()
    expect(summary.guardrails).toEqual({
      questionsRefused: 0,
      answersWithheld: 1,
      lengthWithheld: 1,
    })
    expect(summary.totalAsks).toBe(2)
    expect(summary.answered).toBe(0)
  } finally {
    await server.close()
  }
})
