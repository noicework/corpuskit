import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import { startTestServer } from './support/test-server.ts'
import { sourcePath } from './support/rbac-fixture.ts'
import { fixtureSession } from '../apps/api/src/rbac-integration-fixture.ts'

// Bundle the browser dependencies and forbid outbound browser requests. Only the
// fixture origin is reachable; identity issuers and retrieval services are never called.
const componentHtml = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'">
<link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div>
<script type="module" src="/__test/rbac-component.js"></script></body></html>`
const entrySource = `
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AccessProvider } from '${sourcePath('apps/web/src/components/AccessProvider.tsx')}'
import { PortalAccessGate } from '${sourcePath('apps/web/src/components/PortalAccessGate.tsx')}'
import { AssignmentSection } from '${sourcePath('apps/web/src/components/AssignmentSection.tsx')}'
import { SignInDialog } from '${sourcePath('apps/web/src/components/SignInDialog.tsx')}'
const view = new URLSearchParams(location.search).get('view')
const child = view === 'members'
  ? <main className="rp-tenant rp-shell py-6"><h1>Portal members</h1><AssignmentSection scope={{kind:'portal',slug:'marine'}} name="Marine research" family="members" /></main>
  : view === 'dialog' ? <SignInDialog onClose={() => {}} />
  : <PortalAccessGate><main>Portal content</main></PortalAccessGate>
createRoot(document.getElementById('root')).render(<BrowserRouter><AccessProvider slug="marine">{child}</AccessProvider></BrowserRouter>)
`

async function buildFixture() {
  const directory = await Deno.makeTempDir({ prefix: 'external-signin-ui-' })
  const entry = `${directory}/entry.tsx`
  await Deno.writeTextFile(entry, entrySource)
  try {
    const result = await new Deno.Command('deno', {
      args: [
        'bundle',
        '--config',
        `${Deno.cwd()}/deno.json`,
        '--platform',
        'browser',
        '--deny-import',
        '--output',
        `${directory}/entry.js`,
        entry,
      ],
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    if (!result.success) throw new Error(new TextDecoder().decode(result.stderr))
    return { directory, close: () => Deno.remove(directory, { recursive: true }) }
  } catch (error) {
    await Deno.remove(directory, { recursive: true })
    throw error
  }
}

const externalEnv = {
  EXTERNAL_LOGIN_ISSUER: 'https://identity.example',
  EXTERNAL_LOGIN_JWK: JSON.stringify({
    kty: 'OKP',
    crv: 'Ed25519',
    x: '11qYAYKxCrfVS_7TyWqFVT1RJXsGFiLKXMhzSk2YuOw',
  }),
  EXTERNAL_LOGIN_START_URL: 'https://identity.example/start?portal=marine',
}
const entraEnv = {
  ENTRA_CLIENT_ID: 'fixture-client',
  ENTRA_CLIENT_SECRET: 'fixture-only',
}
// The portal passes its current path, never the query string, for the issuer to echo back.
const externalStart = (returnTo = '/__test/rbac-component') => {
  const url = new URL(externalEnv.EXTERNAL_LOGIN_START_URL)
  url.searchParams.set('returnTo', returnTo)
  return url.href
}

async function click(page: Page, label: string) {
  await page.evaluate((label) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
      item.textContent?.trim() === label
    )
    if (!button) throw new Error(`Missing button ${label}`)
    button.focus()
    button.click()
  }, { args: [label] })
}

async function input(page: Page, selector: string, value: string) {
  await page.evaluate((selector, value) => {
    const element = document.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!
    const prototype = element.tagName === 'SELECT'
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(
      new Event(element.tagName === 'SELECT' ? 'change' : 'input', {
        bubbles: true,
      }),
    )
  }, { args: [selector, value] })
}

Deno.test('external sign-in gate follows runtime configuration and fits desktop and mobile', async () => {
  const fixture = await buildFixture()
  const browser = await launch()
  try {
    for (
      const scenario of [
        { env: entraEnv, label: null, microsoft: true },
        {
          env: { ...entraEnv, ...externalEnv, EXTERNAL_LOGIN_JWK: '' },
          label: null,
          microsoft: true,
        },
        {
          env: { ...entraEnv, ...externalEnv, EXTERNAL_LOGIN_ISSUER: '' },
          label: null,
          microsoft: true,
        },
        {
          env: { ...entraEnv, ...externalEnv, EXTERNAL_LOGIN_START_URL: '' },
          label: null,
          microsoft: true,
        },
        {
          env: { ...entraEnv, ...externalEnv },
          label: 'Continue with your organisation account',
          microsoft: true,
        },
        {
          env: { ...externalEnv, EXTERNAL_LOGIN_NAME: 'Continue with Research ID' },
          label: 'Continue with Research ID',
          microsoft: false,
        },
      ]
    ) {
      const server = startTestServer({
        componentFixture: fixture,
        componentHtml,
        loginEnv: scenario.env,
      })
      server.setAccessMode('marine', 'restricted')
      const page = await browser.newPage(`${server.url}/__test/rbac-component`)
      try {
        await page.waitForSelector('[data-safe-metadata=ready]')
        const links = await page.evaluate(() =>
          [...document.querySelectorAll('main a')].map((item) => ({
            text: item.textContent?.trim(),
            href: item.getAttribute('href'),
          }))
        )
        expect(links.some((link) => link.text === 'Sign in with Microsoft')).toBe(
          scenario.microsoft,
        )
        expect(
          links.filter((link) => link.href?.startsWith(externalEnv.EXTERNAL_LOGIN_START_URL)),
        ).toEqual(scenario.label ? [{ text: scenario.label, href: externalStart() }] : [])
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 900 })
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
            .toBe(true)
        }
        if (scenario.label) {
          await page.evaluate(() =>
            document.querySelector<HTMLElement>('[data-external-login]')!.focus()
          )
          expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe(
            scenario.label,
          )
        }
        await page.goto(`${server.url}/__test/rbac-component?view=dialog`)
        await page.waitForSelector('[role=dialog]')
        await page.waitForFunction(() =>
          document.querySelector('[role=dialog]')?.textContent?.includes('organisation')
        )
        // Wait for the shared access snapshot before inspecting the dialog links.
        await page.waitForFunction(() =>
          !document.body.textContent?.includes('Access could not be checked.')
        )
        if (scenario.label) {
          await page.waitForSelector('[data-external-login]')
          expect(
            await page.evaluate(() => {
              const link = document.querySelector('[data-external-login]')
              return { text: link?.textContent?.trim(), href: link?.getAttribute('href') }
            }),
          ).toEqual({ text: scenario.label, href: externalStart() })
        }
        expect(server.providerCalls).toEqual([])
      } finally {
        await page.close()
        await server.close()
      }
    }
  } finally {
    await browser.close()
    await fixture.close()
  }
})

Deno.test('member form creates separate Entra and external assignments for the same email', async () => {
  const fixture = await buildFixture()
  const server = startTestServer({
    componentFixture: fixture,
    componentHtml,
    identity: { role: 'portal-admin' },
    loginEnv: { ...entraEnv, ...externalEnv },
  })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/__test/rbac-component?view=members`)
  try {
    await page.waitForSelector('[data-assignment-editor]')
    for (const source of ['entra', 'external']) {
      await click(page, 'Add member')
      await input(page, '[data-assignment-source-input]', source)
      await input(page, '[data-assignment-subject]', 'shared@example.test')
      await click(page, 'Add member')
      await page.waitForFunction(() =>
        !document.querySelector('[data-assignment-editor] form') &&
        !!document.querySelector('[data-assignment-editor]')
      )
    }
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll('[data-assignment-id]')]
          .filter((row) => row.querySelector('p')?.textContent === 'shared@example.test')
          .map((row) =>
            row.querySelector('[data-assignment-source]')?.getAttribute('data-assignment-source')
          ).sort()
      ),
    ).toEqual(['entra', 'external'])
    await click(page, 'Add member')
    await input(page, '[data-assignment-source-input]', 'external')
    await page.evaluate(() => {
      const select = [...document.querySelectorAll<HTMLSelectElement>('select')].find((item) =>
        item.querySelector('option[value="active-oid"]')
      )!
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(
        select,
        'active-oid',
      )
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await input(page, '[data-assignment-subject]', 'ext:research-reader')
    await click(page, 'Add member')
    await page.waitForFunction(() =>
      !document.querySelector('[data-assignment-editor] form') &&
      document.body.textContent?.includes('ext:research-reader')
    )
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
    }
    expect(
      server.requests.filter((request) => request.method === 'POST').map((request) =>
        request.status
      ),
    ).toEqual([201, 201, 201])
  } finally {
    await page.close()
    await browser.close()
    await server.close()
    await fixture.close()
  }
})

Deno.test('member form keeps its original fields when external sign-in is not configured', async () => {
  const fixture = await buildFixture()
  const server = startTestServer({
    componentFixture: fixture,
    componentHtml,
    identity: { role: 'portal-admin' },
    loginEnv: entraEnv,
  })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/__test/rbac-component?view=members`)
  try {
    await page.waitForSelector('[data-assignment-editor]')
    await click(page, 'Add member')
    await page.waitForSelector('[data-assignment-editor] form')
    expect(
      await page.evaluate(() => ({
        sourceInput: !!document.querySelector('[data-assignment-source-input]'),
        sourceLabels: document.querySelectorAll('[data-assignment-source]').length,
        firstSelect: [...document.querySelectorAll('form select option')].map((option) =>
          option.getAttribute('value')
        ).slice(0, 2),
      })),
    ).toEqual({ sourceInput: false, sourceLabels: 0, firstSelect: ['pending-email', 'active-oid'] })
    expect(server.providerCalls).toEqual([])
  } finally {
    await page.close()
    await browser.close()
    await server.close()
    await fixture.close()
  }
})

Deno.test('external local assignment opens the portal and preserves profile sign-out', async () => {
  const fixture = await buildFixture()
  const server = startTestServer({
    componentFixture: fixture,
    componentHtml,
    loginEnv: externalEnv,
  })
  server.setAccessMode('marine', 'restricted')
  server.setAssignment(
    { kind: 'portal', slug: 'marine' },
    'reader@example.test',
    'viewer',
    'pending-email',
    'external',
  )
  server.setIdentity(fixtureSession({
    tenantId: 'external',
    oid: 'ext:reader',
    email: 'reader@example.test',
    provenance: 'external',
    roles: [],
    groups: [],
    groupStatus: 'absent',
  }))
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/__test/rbac-component`)
  try {
    await page.waitForFunction(() =>
      document.querySelector('main')?.textContent === 'Portal content'
    )
    await page.goto(`${server.url}/__test/rbac-component?view=dialog`)
    await page.waitForFunction(() =>
      document.querySelector('[role=dialog]')?.textContent?.includes(
        'Signed in through the external identity provider.',
      )
    )
    const profile = await page.evaluate(() => ({
      text: document.querySelector('[role=dialog]')?.textContent,
      links: [...document.querySelectorAll('[role=dialog] a')].map((item) => ({
        text: item.textContent?.trim(),
        href: item.getAttribute('href'),
      })),
    }))
    expect(profile.text).toContain('Local assignment')
    expect(profile.text).not.toContain('Entra claims')
    expect(profile.links).toEqual([
      { text: 'Sign in again', href: externalStart() },
      { text: 'Sign out', href: '/auth/logout' },
    ])
    await page.evaluate(() =>
      document.querySelector<HTMLAnchorElement>('a[href="/auth/logout"]')!.focus()
    )
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe(
      'Close',
    )
    expect(server.providerCalls).toEqual([])
  } finally {
    await page.close()
    await browser.close()
    await server.close()
    await fixture.close()
  }
})
