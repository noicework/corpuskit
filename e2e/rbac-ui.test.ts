import { expect } from '@std/expect'
import { launch } from '@astral/astral'
import { startTestServer } from './support/test-server.ts'
import { assertCurrentBuild, captureBoundary } from './support/rbac-fixture.ts'
import { fixtureSession } from '../apps/api/src/rbac-integration-fixture.ts'

// Independently transcribed from D1 and D2. Neither authorize(), role ordering nor
// returned permissions calculate these expected outcomes. Grains is restricted
// and each portal role is assigned to marine only.
const scenarios = [
  {
    persona: 'anonymous',
    marine: [true, false, false, false],
    grains: [false, false, false, false],
    estate: false,
    people: false,
  },
  {
    persona: 'viewer',
    marine: [true, false, false, false],
    grains: [false, false, false, false],
    estate: false,
    people: false,
  },
  {
    persona: 'analyst',
    marine: [true, true, false, false],
    grains: [false, false, false, false],
    estate: false,
    people: false,
  },
  {
    persona: 'curator',
    marine: [true, true, true, false],
    grains: [false, false, false, false],
    estate: false,
    people: false,
  },
  {
    persona: 'portal-admin',
    marine: [true, true, true, true],
    grains: [false, false, false, false],
    estate: false,
    people: false,
  },
  {
    persona: 'platform-admin',
    marine: [true, true, true, true],
    grains: [true, true, true, true],
    estate: true,
    people: false,
  },
  {
    persona: 'owner',
    marine: [true, true, true, true],
    grains: [true, true, true, true],
    estate: true,
    people: true,
  },
  {
    persona: 'denied',
    marine: [false, false, false, false],
    grains: [false, false, false, false],
    estate: false,
    people: false,
  },
] as const

// Detailed real forms, output sinks and independent subpermissions remain owned
// by their focused suites. This manifest is an execution inventory, not proof by
// source string. Plan 04-18 runs every listed suite alongside this matrix.
export const actionFamilySuites = {
  shellAndSwitchers: 'rbac-navigation',
  sourceReadsAndEmbeddedAsk: 'rbac-reading',
  askAndAdvisory: 'rbac-ask',
  generateAndPrint: 'rbac-generation',
  investigationsEvidenceAndCurrent: 'rbac-investigations',
  anonymousStorage: 'rbac-storage',
  watchesAndLocalExports: 'rbac-export',
  manageAndConnections: 'rbac-manage',
  contentSourcesTaxonomy: 'rbac-content',
  specialistAndSubpermissions: 'rbac-specialist',
  estateCreateEnableDeleteMigrate: 'rbac-platform',
  accessMembers: 'rbac-members',
  groupsAndAccessMode: 'rbac-access-mode',
  peopleAndPlatformGroups: 'rbac-people',
  keysAndTools: 'rbac-keys',
  scopedAudit: 'rbac-audit',
  scopedAuditExport: 'rbac-audit-export',
} as const

Deno.test('independent persona matrix checks both slugs, real UI reads and backend negative controls', async () => {
  const browser = await launch()
  try {
    for (const scenario of scenarios) {
      const server = startTestServer(
        scenario.persona === 'anonymous' || scenario.persona === 'denied'
          ? {}
          : { identity: { role: scenario.persona } },
      )
      server.setAccessMode('grains', 'restricted')
      if (scenario.persona === 'denied') {
        server.setAccessMode('marine', 'restricted')
        server.setIdentity(fixtureSession({ oid: 'no-assignments' }))
      }
      const page = await browser.newPage()
      try {
        for (const slug of ['marine', 'grains'] as const) {
          const [read, generate, curate, administer] = scenario[slug]
          const before = server.requests.length
          await page.goto(`${server.url}/t/${slug}/library`)
          await page.waitForSelector(read ? 'input[type=search]' : '[data-access-state=denied]')
          if (read) {
            await page.waitForSelector(`a[href="/t/${slug}/library/res-1"]`)
            expect(
              server.requests.slice(before).some((r) =>
                r.path.startsWith(`/api/t/${slug}/catalog`) && r.status === 200
              ),
            ).toBe(true)
            expect(await page.$(`nav[aria-label=Primary] a[href="/t/${slug}/generate"]`) !== null)
              .toBe(generate)
            if (curate) {
              await page.evaluate(() =>
                document.querySelector<HTMLButtonElement>('button[title="My account"]')!.focus()
              )
              await page.keyboard.press('ArrowDown')
              await page.waitForSelector('[role=menu]')
              expect(await page.$(`[role=menu] a[href="/t/${slug}/manage"]`)).not.toBeNull()
              await page.keyboard.press('Escape')
            } else {
              expect(await page.$(`a[href="/t/${slug}/manage"]`)).toBeNull()
            }
          } else {
            expect(
              server.requests.slice(before).filter((r) =>
                r.path.startsWith('/api/') && r.path !== `/api/t/${slug}/config`
              ),
            ).toEqual([])
            expect(await page.evaluate(() => document.body.innerText)).not.toContain(
              'Abalone populations',
            )
          }
          // These browser requests hit signed ingress and declared routes. Denial
          // is checked independently even when navigation hides the operation.
          const probes = await page.evaluate(async (slug) => {
            const paths = [
              `/api/t/${slug}/resources/res-1`,
              `/api/t/${slug}/investigations`,
              `/api/admin/t/${slug}/sources`,
              `/api/t/${slug}/mcp/keys`,
              '/api/admin/overview',
            ]
            const results = []
            for (const [index, path] of paths.entries()) {
              const response = await fetch(
                path,
                index === 1
                  ? {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ name: 'Independent matrix notebook' }),
                  }
                  : undefined,
              )
              results.push({ status: response.status, body: await response.json() })
            }
            return results
          }, { args: [slug] })
          for (
            const [index, allowed] of [read, generate, curate, administer, scenario.estate]
              .entries()
          ) {
            expect(probes[index]!.status, `${scenario.persona}/${slug}/${index}`).toBe(
              allowed ? 200 : scenario.persona === 'anonymous' ? 401 : 403,
            )
            if (!allowed) {
              expect(probes[index]!.body.error).toBe(
                scenario.persona === 'anonymous' ? 'unauthorised' : 'forbidden',
              )
            }
          }
          if (!generate && read) {
            const mark = server.requests.length
            await page.goto(`${server.url}/t/${slug}/generate?query=abalone&autostart=1`)
            await page.waitForSelector('[data-route-unavailable]')
            expect(
              server.requests.slice(mark).filter((r) =>
                /\/(generate|verdicts|followups)$/.test(r.path)
              ),
            ).toEqual([])
            expect(await page.$('button[aria-label="Save to investigation"]')).toBeNull()
          }
        }
        await page.goto(`${server.url}/t/marine/library`)
        await page.waitForSelector(
          scenario.marine[0] ? 'input[type=search]' : '[data-access-state=denied]',
        )
        await assertCurrentBuild(page)
        if (scenario.marine[0]) {
          await page.evaluate(() =>
            dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
          )
          await page.waitForSelector('[role=combobox]')
          const commands = await page.evaluate(() =>
            [...document.querySelectorAll('[role=option]')].map((el) => el.textContent?.trim())
          )
          expect(commands.includes('People')).toBe(scenario.people)
          await page.keyboard.press('Escape')
        }
        if (scenario.persona === 'anonymous' || scenario.persona === 'denied') {
          for (const scheme of ['light', 'dark']) {
            server.tenants.patchBranding('marine', {
              paletteId: scheme === 'dark' ? 'observatory' : 'default',
              shape: 'soft',
              density: 'spacious',
              typography: 'lexend-zilla',
            })
            await page.evaluate((scheme) => localStorage.setItem('rp-scheme', scheme), {
              args: [scheme],
            })
            await page.goto(`${server.url}/t/marine/library`)
            await page.waitForSelector(
              scenario.marine[0] ? 'input[type=search]' : '[data-safe-metadata=ready]',
            )
            for (const width of [1440, 390]) {
              await captureBoundary(
                page,
                '.planning/logs/04-18-01',
                `${scenario.persona}-${scheme}-${width}`,
                width,
              )
            }
          }
        }
      } finally {
        await page.close()
        await server.close()
      }
    }
  } finally {
    await browser.close()
  }
})
