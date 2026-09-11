import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import { type EmergencyFixtureState, startTestServer } from './support/test-server.ts'

async function digest(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer))]
    .map((value) => value.toString(16).padStart(2, '0')).join('')
}

async function click(page: Page, selector: string) {
  await (await page.waitForSelector(selector)).click()
}

async function settle(page: Page) {
  await page.evaluate(() =>
    new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    )
  )
}

Deno.test({
  name: 'emergency access real component, one request, accessible themes and fresh assets',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const marker = `emergency-${crypto.randomUUID()}`
    const directory = `.planning/logs/02-09-fixture-${marker}`
    await Deno.mkdir(directory, { recursive: true })
    const command = await new Deno.Command('esbuild', {
      args: [
        'e2e/support/emergency-access-entry.tsx',
        '--bundle',
        '--format=esm',
        '--jsx=automatic',
        `--outfile=${directory}/entry.js`,
        '--alias:@research-portal/core=./packages/core/src/index.ts',
        '--external:react',
        '--external:react/jsx-runtime',
        '--external:react-dom',
        '--external:react-dom/client',
        '--external:@tanstack/react-query',
        '--external:zod',
        `--define:__EMERGENCY_FIXTURE_BUILD__=${JSON.stringify(marker)}`,
      ],
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    expect(command.success, new TextDecoder().decode(command.stderr)).toBe(true)
    const appHash = await digest(await Deno.readFile('apps/web/dist/app.js'))
    const fixtureHash = await digest(await Deno.readFile(`${directory}/entry.js`))
    const stamp = JSON.parse(await Deno.readTextFile('apps/web/dist/build.json'))
    expect(Date.now() - Date.parse(stamp.builtAt)).toBeLessThan(180_000)
    const state: EmergencyFixtureState = {
      capability: 'enabled',
      status: 200,
      requests: 0,
      credentialRequests: 0,
      delayMs: 0,
    }
    const server = startTestServer({ emergencyFixture: { directory, state } })
    const browser = await launch()
    const evidence: unknown[] = []
    let page: Page | undefined
    try {
      page = await browser.newPage(`${server.url}/__test/emergency-access`)
      await page.waitForSelector('[data-fixture-ready]')
      const fresh = await page.evaluate(async () => {
        async function hash(path: string) {
          const bytes = await (await fetch(path, { cache: 'no-store' })).arrayBuffer()
          return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
            .map((v) => v.toString(16).padStart(2, '0')).join('')
        }
        return {
          appHash: await hash('/app.js'),
          fixtureHash: await hash('/__test/emergency-access.js'),
          stamp: await (await fetch('/build.json', { cache: 'no-store' })).json(),
          marker: document.querySelector('[data-fixture-build]')?.getAttribute(
            'data-fixture-build',
          ),
        }
      })
      expect(fresh).toEqual({ appHash, fixtureHash, stamp, marker })
      evidence.push({ freshness: fresh })
      await page.close()
      page = undefined

      for (const palette of ['light', 'observatory']) {
        for (const width of [1440, 390]) {
          state.capability = 'enabled'
          state.status = 200
          page = await browser.newPage(`${server.url}/__test/emergency-access?palette=${palette}`)
          await page.setViewportSize({ width, height: 1000 })
          await page.waitForSelector('#emergency-entry')
          await page.evaluate(() => {
            document.documentElement.style.fontSize = '22px'
          })
          await click(page, '#emergency-entry')
          await page.waitForSelector('[role=dialog] input')
          await settle(page)
          const metrics = await page.evaluate(() => {
            const dialog = document.querySelector<HTMLElement>('[role=dialog]')!
            const input = dialog.querySelector('input')!
            const button = dialog.querySelector<HTMLElement>('[type=submit]')!
            const surface = getComputedStyle(dialog)
            const probe = document.createElement('span')
            probe.style.cssText =
              'background:var(--rp-surface);border-radius:var(--rp-radius);font-family:var(--rp-font-body);color:var(--rp-ink)'
            dialog.append(probe)
            const tokens = getComputedStyle(probe)
            const result = {
              width: innerWidth,
              overflow: document.documentElement.scrollWidth - innerWidth,
              rootFont: getComputedStyle(document.documentElement).fontSize,
              focused: document.activeElement === input,
              radius: surface.borderRadius,
              tokenRadius: tokens.borderRadius,
              background: surface.backgroundColor,
              tokenBackground: tokens.backgroundColor,
              font: surface.fontFamily,
              tokenFont: tokens.fontFamily,
              density: surface.getPropertyValue('--rp-density').trim(),
              buttonOverflow: button.scrollHeight - button.clientHeight,
              dialogLeft: dialog.getBoundingClientRect().left,
              dialogRight: dialog.getBoundingClientRect().right,
            }
            probe.remove()
            return result
          })
          expect(metrics.width).toBe(width)
          expect(metrics.overflow).toBeLessThanOrEqual(1)
          expect(metrics.rootFont).toBe('22px')
          expect(metrics.focused).toBe(true)
          expect(metrics.radius).toBe(metrics.tokenRadius)
          expect(metrics.background).toBe(metrics.tokenBackground)
          expect(metrics.font).toBe(metrics.tokenFont)
          expect(metrics.buttonOverflow).toBeLessThanOrEqual(1)
          expect(metrics.dialogLeft).toBeGreaterThanOrEqual(0)
          expect(metrics.dialogRight).toBeLessThanOrEqual(width)
          const screenshot = `${directory}/${palette}-${width}-prompt.png`
          await Deno.writeFile(screenshot, await page.screenshot())
          evidence.push({ palette, ...metrics, screenshot })
          await page.keyboard.down('Shift')
          await page.keyboard.press('Tab')
          await page.keyboard.up('Shift')
          expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Cancel')
          await page.keyboard.press('Tab')
          expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('INPUT')
          for (let i = 0; i < 5; i++) await page.keyboard.press('Tab')
          expect(
            await page.evaluate(() =>
              document.querySelector('[role=dialog]')!.contains(document.activeElement)
            ),
          ).toBe(true)
          const before = state.requests
          await page.keyboard.press('Escape')
          await settle(page)
          expect(state.requests).toBe(before)
          expect(await page.evaluate(() => document.querySelector('[role=dialog]'))).toBe(null)
          expect(await page.evaluate(() => document.activeElement?.id)).toBe('emergency-entry')
          await Deno.writeFile(
            `${directory}/${palette}-${width}-cancelled.png`,
            await page.screenshot(),
          )
          await page.close()
          page = undefined
        }
      }

      for (const capability of ['disabled', 'unknown', 'failed', 'loading'] as const) {
        state.capability = capability
        page = await browser.newPage(`${server.url}/__test/emergency-access`)
        await page.waitForSelector('[data-fixture-mounted]')
        if (capability !== 'loading') await page.waitForSelector('[data-fixture-ready]')
        expect(await page.evaluate(() => document.querySelector('#emergency-entry'))).toBe(null)
        expect(await page.evaluate(() => document.querySelector('input[type=password]'))).toBe(null)
        await Deno.writeFile(`${directory}/${capability}.png`, await page.screenshot())
        await page.close()
        page = undefined
      }

      state.capability = 'enabled'
      for (const status of [401, 403, 429, 500, 200]) {
        state.status = status
        state.delayMs = 700
        const before = state.requests
        page = await browser.newPage(`${server.url}/__test/emergency-access?palette=observatory`)
        await page.setViewportSize({ width: 390, height: 1000 })
        await page.waitForSelector('#emergency-entry')
        await click(page, '#emergency-entry')
        await (await page.waitForSelector('input[type=password]')).type('fixture-only-value')
        await page.evaluate(() => {
          const form = document.querySelector('form')!
          form.requestSubmit()
          form.requestSubmit()
        })
        await page.waitForSelector('[aria-busy=true]')
        expect(
          await page.evaluate(() =>
            document.querySelector<HTMLButtonElement>('[data-emergency-cancel]')!.disabled
          ),
        ).toBe(true)
        await page.keyboard.press('Escape')
        await page.keyboard.press('Tab')
        expect(await page.evaluate(() => document.activeElement?.getAttribute('role'))).toBe(
          'dialog',
        )
        expect(await page.evaluate(() => document.querySelectorAll('[role=dialog]').length)).toBe(1)
        expect(await page.evaluate(() => document.querySelector<HTMLInputElement>('input')!.value))
          .toBe('')
        await Deno.writeFile(`${directory}/${status}-pending.png`, await page.screenshot())
        await page.waitForSelector(status === 200 ? '[data-outcome=completed]' : '[role=alert]')
        expect(state.requests).toBe(before + 1)
        const message = await page.evaluate(() =>
          document.querySelector('[role=alert]')?.textContent ?? ''
        )
        if (status === 429) expect(message).toContain('3 minutes')
        if (status === 401 || status === 403) expect(message).toContain('was not accepted')
        if (status === 500) expect(message).toContain('Check whether the action completed')
        await Deno.writeFile(`${directory}/${status}-result.png`, await page.screenshot())
        expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not
          .toContain('fixture-only-value')
        expect(await page.evaluate(() => location.href)).not.toContain('fixture-only-value')
        if (status !== 200) {
          expect(
            await page.evaluate(() =>
              document.activeElement?.hasAttribute('data-emergency-cancel')
            ),
          ).toBe(true)
          expect(
            await page.evaluate(() =>
              document.querySelector<HTMLButtonElement>('[type=submit]')!.disabled
            ),
          ).toBe(true)
          await click(page, '[data-emergency-cancel]')
        }
        await page.close()
        page = undefined
      }

      state.delayMs = 0
      state.status = 200
      // Losing capability during dispatch is uncertain, never a zero-request cancellation.
      state.capability = 'enabled'
      state.delayMs = 1000
      page = await browser.newPage(`${server.url}/__test/emergency-access`)
      await page.waitForSelector('#emergency-entry')
      const beforeLoss = state.requests
      await click(page, '#emergency-entry')
      await (await page.waitForSelector('input[type=password]')).type('fixture-only-value')
      await click(page, '[type=submit]')
      await page.waitForSelector('[aria-busy=true]')
      state.capability = 'disabled'
      await page.evaluate(() => dispatchEvent(new Event('fixture-refresh-capability')))
      await page.waitForSelector('[data-outcome=failed]')
      expect(await page.evaluate(() => document.querySelector('[role=dialog]'))).toBe(null)
      state.capability = 'enabled'
      await page.evaluate(() => dispatchEvent(new Event('fixture-refresh-capability')))
      await click(page, '#emergency-entry')
      await settle(page)
      expect(await page.evaluate(() => document.querySelector('[role=dialog]'))).toBe(null)
      expect(state.requests).toBe(beforeLoss + 1)
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1100)))
      await click(page, '#emergency-entry')
      await page.waitForSelector('input[type=password]')
      expect(await page.evaluate(() => document.querySelector<HTMLInputElement>('input')!.value))
        .toBe('')
      await click(page, '[data-emergency-cancel]')
      evidence.push({ scenario: 'pending-capability-loss', requests: state.requests - beforeLoss })
      await page.close()
      page = undefined
      state.delayMs = 0
      for (
        const scenario of [
          'cancel',
          'batch',
          'network',
          'capability-loss',
          'session',
          'unmount',
          'stack',
        ]
      ) {
        state.capability = scenario === 'session' ? 'session' : 'enabled'
        page = await browser.newPage(`${server.url}/__test/emergency-access?scenario=${scenario}`)
        await page.waitForSelector('[data-fixture-ready]')
        const before = state.requests
        if (scenario === 'session') {
          const credentials = state.credentialRequests
          await click(page, '#session-action')
          await page.waitForSelector('[data-outcome=completed]')
          expect(state.requests).toBe(before + 1)
          expect(state.credentialRequests).toBe(credentials)
          expect(await page.evaluate(() => document.querySelector('[role=dialog]'))).toBe(null)
        } else {
          await click(page, '#emergency-entry')
          await (await page.waitForSelector('input[type=password]')).type('fixture-only-value')
          if (scenario === 'cancel') {
            await click(page, '[data-emergency-cancel]')
          } else if (scenario === 'unmount') {
            expect(
              await page.evaluate(async () => {
                const input = document.querySelector<HTMLInputElement>('input')!
                dispatchEvent(new Event('fixture-unmount'))
                await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
                return input.value
              }),
            ).toBe('')
          } else if (scenario === 'stack') {
            await page.evaluate(() => document.getElementById('emergency-entry')!.click())
            expect(await page.evaluate(() => document.querySelectorAll('[role=dialog]').length))
              .toBe(1)
            await click(page, '[data-emergency-cancel]')
          } else if (scenario === 'capability-loss') {
            state.capability = 'disabled'
            await page.evaluate(() => dispatchEvent(new Event('fixture-refresh-capability')))
            await page.waitForSelector('[data-outcome=cancelled]')
          } else {
            if (scenario === 'network') {
              await page.evaluate(() => {
                const original = fetch
                globalThis.fetch = (input, init) =>
                  String(input).includes('__test/emergency-action')
                    ? Promise.reject(new TypeError('Network unavailable'))
                    : original(input, init)
              })
            }
            await click(page, '[type=submit]')
            await page.waitForSelector('[role=alert]')
          }
          expect(state.requests).toBe(before + (scenario === 'batch' ? 1 : 0))
          expect(
            await page.evaluate(() =>
              document.querySelector<HTMLInputElement>('input')?.value ?? ''
            ),
          ).toBe('')
        }
        evidence.push({ scenario, requests: state.requests - before })
        await page.close()
        page = undefined
      }
      state.capability = 'enabled'
      state.status = 403
      page = await browser.newPage(`${server.url}/__test/emergency-access`)
      await page.waitForSelector('#emergency-entry')
      await page.evaluate(async () => {
        await fetch('/api/admin/__test/emergency-action')
        await fetch('/auth/me')
        dispatchEvent(new Event('focus'))
      })
      expect(await page.evaluate(() => document.querySelector('[role=dialog]'))).toBe(null)
      evidence.push({ scenario: 'background-denial', prompts: 0 })
      await page.close()
      page = undefined
    } finally {
      await Deno.writeTextFile(`${directory}/evidence.json`, JSON.stringify(evidence, null, 2))
      await page?.close()
      await browser.close()
      await server.close()
      await Deno.remove(`${directory}/entry.js`)
    }
    console.log(`Emergency access evidence: ${directory}/evidence.json`)
  },
})
