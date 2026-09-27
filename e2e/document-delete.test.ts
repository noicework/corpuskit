import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import { startTestServer } from './support/test-server.ts'
import { assertCurrentBuild } from './support/rbac-fixture.ts'
import { DoubleProvider, RESOURCE_ONE, RESOURCE_TWO } from './support/double-provider.ts'
import type { BuildAppOptions } from '../apps/api/src/app.ts'

/** A collection a manager can delete from: readers and managers see the same documents. */
class DeletableCollection extends DoubleProvider {
  list() {
    return [...this.resources]
  }
  remove(id: string) {
    this.resources = this.resources.filter((resource) => resource.id !== id)
  }
}

/** The knowledge box behind the collection, as the manager's lists and the delete reach it. */
function collectionManagement(collection: DeletableCollection) {
  const calls: string[] = []
  const management = new Proxy({}, {
    get: (_target, method) => (...args: unknown[]) => {
      calls.push(String(method))
      const documents = collection.list()
      switch (method) {
        case 'counters':
          return Promise.resolve({
            resources: documents.length,
            paragraphs: documents.length * 14,
            sentences: documents.length * 28,
            indexMb: 1,
          })
        case 'resourceCount':
          return Promise.resolve(documents.length)
        case 'recentResources':
          return Promise.resolve(documents.map((resource) => ({
            id: resource.id,
            title: resource.title,
            status: 'processed',
            hidden: false,
          })))
        case 'corpusHealth':
          return Promise.resolve(documents.map((resource) => ({
            id: resource.id,
            title: resource.title,
            status: 'thin',
            words: 4,
            hidden: false,
          })))
        case 'deleteResource':
          collection.remove(args[1] as string)
          return Promise.resolve()
        case 'agentConfigs':
          return Promise.resolve([])
        case 'thumbnailResponse':
          return Promise.resolve(new Response(null, { status: 404 }))
        default:
          return Promise.reject(new Error(`Unsupported delete fixture: ${String(method)}`))
      }
    },
  }) as NonNullable<BuildAppOptions['management']>
  return { management, calls }
}

async function textShown(page: Page, text: string, within = 'body') {
  try {
    await page.waitForFunction(
      (text: string, within: string) =>
        [...document.querySelectorAll(within)].some((node) =>
          (node as HTMLElement).innerText?.includes(text)
        ),
      { args: [text, within] },
    )
  } catch (error) {
    console.error('Missing text', text, await page.evaluate(() => document.body.innerText))
    throw error
  }
}
const activeText = (page: Page) =>
  page.evaluate(() => document.activeElement?.textContent?.trim() ?? '')
async function clickDialogButton(page: Page, text: string) {
  await page.waitForFunction(
    (text: string) =>
      [...document.querySelectorAll('dialog button')].some((b) =>
        b.textContent?.trim() === text && !(b as HTMLButtonElement).disabled
      ),
    { args: [text] },
  )
  await page.evaluate((text: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find((b) =>
      b.textContent?.trim() === text
    )
    if (!button) throw new Error(`Missing dialog button: ${text}`)
    button.click()
  }, { args: [text] })
}
async function openDelete(page: Page, id: string) {
  const selector = `[data-delete-document="${id}"]`
  await page.waitForSelector(selector)
  await page.evaluate((selector: string) => {
    const button = document.querySelector<HTMLButtonElement>(selector)!
    button.focus()
    button.click()
  }, { args: [selector] })
  await page.waitForSelector('dialog[open]')
}

Deno.test('a manager deletes from Recent additions through an accessible confirmation, and counts refresh', async () => {
  const collection = new DeletableCollection()
  const { management, calls } = collectionManagement(collection)
  const server = startTestServer({
    identity: { role: 'curator' },
    management,
    provider: collection,
  })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/manage?tab=content`)
  try {
    await assertCurrentBuild(page)
    await openDelete(page, RESOURCE_TWO.id)
    // The dialog names the document and says what deleting it means; the safe choice has focus.
    const dialog = await page.evaluate(() => document.querySelector('dialog')!.innerText)
    expect(dialog).toContain('Delete document')
    expect(dialog).toContain(RESOURCE_TWO.title)
    expect(dialog).toContain('This cannot be undone.')
    expect(dialog).toContain('It is removed from the Library, from search and from answers.')
    expect(dialog).toContain('Investigations that cite it keep the passages people saved')
    expect(await activeText(page)).toBe('Keep document')
    // Focus stays inside the dialog in both directions.
    await page.keyboard.down('Shift')
    await page.keyboard.press('Tab')
    await page.keyboard.up('Shift')
    expect(await activeText(page)).toBe('Delete document')
    await page.keyboard.press('Tab')
    expect(await activeText(page)).toBe('Keep document')
    // Escape cancels: nothing is sent, and focus goes back to the row's Delete.
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('dialog'))
    await page.waitForFunction(
      (id: string) => document.activeElement?.getAttribute('data-delete-document') === id,
      {
        args: [RESOURCE_TWO.id],
      },
    )
    expect(server.requests.filter((r) => r.method === 'DELETE')).toEqual([])
    expect(calls).not.toContain('deleteResource')

    const counted = server.requests.filter((r) => r.path.endsWith('/api/admin/t/marine/counters'))
      .length
    await openDelete(page, RESOURCE_TWO.id)
    await clickDialogButton(page, 'Delete document')
    // The outcome is announced in the list's live region, and the row is gone.
    await textShown(page, `Deleted “${RESOURCE_TWO.title}”.`, '[role=status]')
    await page.waitForFunction(
      (id: string) => !document.querySelector(`[data-delete-document="${id}"]`),
      { args: [RESOURCE_TWO.id] },
    )
    // Focus moves to the list, not the page body, as the row goes.
    await page.waitForFunction(() =>
      document.activeElement?.textContent?.trim() === 'Recent additions'
    )
    expect(server.requests.filter((r) => r.method === 'DELETE')).toEqual([{
      path: `/api/admin/t/marine/resources/${RESOURCE_TWO.id}`,
      method: 'DELETE',
      status: 200,
    }])
    // Counts are read again without a reload.
    const counts = () =>
      server.requests.filter((r) => r.path.endsWith('/api/admin/t/marine/counters')).length
    for (let tries = 0; tries < 100 && counts() <= counted; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(counts()).toBeGreaterThan(counted)
    expect(collection.list().map((resource) => resource.id)).toEqual([RESOURCE_ONE.id])
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('a manager deletes from a document page and lands back in the Library, which says so', async () => {
  const collection = new DeletableCollection()
  const { management } = collectionManagement(collection)
  const server = startTestServer({
    identity: { role: 'curator' },
    management,
    provider: collection,
  })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/library/${RESOURCE_ONE.id}`)
  try {
    await assertCurrentBuild(page)
    await page.waitForFunction(
      (title: string) => document.querySelector('h1')?.textContent?.includes(title),
      { args: [RESOURCE_ONE.title] },
    )
    await openDelete(page, RESOURCE_ONE.id)
    await clickDialogButton(page, 'Delete document')
    await page.waitForFunction(() => location.pathname === '/t/marine/library')
    await textShown(page, `Deleted “${RESOURCE_ONE.title}”.`, 'main [role=status]')
    // The Library no longer lists it, and still lists the rest.
    await page.waitForFunction(
      (gone: string, kept: string) =>
        !document.querySelector(`main a[href$="/library/${gone}"]`) &&
        !!document.querySelector(`main a[href$="/library/${kept}"]`),
      { args: [RESOURCE_ONE.id, RESOURCE_TWO.id] },
    )
    expect(server.requests.filter((r) => r.method === 'DELETE')).toEqual([{
      path: `/api/admin/t/marine/resources/${RESOURCE_ONE.id}`,
      method: 'DELETE',
      status: 200,
    }])
    // Said once: the page's history entry no longer carries it.
    expect(await page.evaluate(() => history.state?.usr ?? null)).toBeNull()
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('a manager deletes a thin page from corpus health, and focus stays in the panel', async () => {
  const collection = new DeletableCollection()
  const { management } = collectionManagement(collection)
  const server = startTestServer({
    identity: { role: 'curator' },
    management,
    provider: collection,
  })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/manage?tab=content`)
  try {
    await assertCurrentBuild(page)
    await page.waitForSelector('[data-admin-health]')
    await page.evaluate(() => {
      const scan = [...document.querySelectorAll<HTMLButtonElement>('[data-admin-health] button')]
        .find((button) => button.textContent?.trim() === 'Scan corpus')
      if (!scan) throw new Error('Missing scan')
      scan.click()
    })
    const row = `[data-admin-health] [data-delete-document="${RESOURCE_TWO.id}"]`
    await page.waitForSelector(row)
    await page.evaluate((row: string) => {
      const button = document.querySelector<HTMLButtonElement>(row)!
      button.focus()
      button.click()
    }, { args: [row] })
    await page.waitForSelector('dialog[open]')
    expect(await page.evaluate(() => document.querySelector('dialog')!.innerText)).toContain(
      RESOURCE_TWO.title,
    )
    await clickDialogButton(page, 'Delete document')
    await textShown(
      page,
      `Deleted \u201c${RESOURCE_TWO.title}\u201d.`,
      '[data-admin-health] [role=status]',
    )
    await page.waitForFunction((row: string) => !document.querySelector(row), { args: [row] })
    await page.waitForFunction(() =>
      document.activeElement?.textContent?.trim() === 'Corpus health'
    )
    expect(collection.list().map((resource) => resource.id)).toEqual([RESOURCE_ONE.id])
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('viewers and visitors never see a way to delete, and send no delete', async () => {
  const browser = await launch()
  try {
    // The curator shows the control is there to be seen; everyone else must not see it.
    for (const role of ['curator', 'viewer', 'analyst', null] as const) {
      const manager = role === 'curator'
      const collection = new DeletableCollection()
      const { management, calls } = collectionManagement(collection)
      const server = startTestServer({
        ...(role ? { identity: { role } } : {}),
        management,
        provider: collection,
      })
      const page = await browser.newPage(`${server.url}/t/marine/library/${RESOURCE_ONE.id}`)
      try {
        await assertCurrentBuild(page)
        await page.waitForFunction(
          (title: string) => document.querySelector('h1')?.textContent?.includes(title),
          {
            args: [RESOURCE_ONE.title],
          },
        )
        if (manager) await page.waitForSelector(`[data-delete-document="${RESOURCE_ONE.id}"]`)
        expect(!!(await page.$('[data-delete-document]')), `${role} on the document`).toBe(manager)
        await page.goto(`${server.url}/t/marine/manage?tab=content`)
        if (manager) await page.waitForSelector(`[data-delete-document="${RESOURCE_TWO.id}"]`)
        else await page.waitForSelector('[data-route-unavailable]')
        expect(!!(await page.$('[data-delete-document]')), `${role} in Manage`).toBe(manager)
        expect(server.requests.filter((r) => r.method === 'DELETE'), `${role}`).toEqual([])
        expect(calls, `${role}`).not.toContain('deleteResource')
      } finally {
        await page.close()
        await server.close()
      }
    }
  } finally {
    await browser.close()
  }
})

Deno.test('evidence saved from a deleted document stays, shown as no longer in the Library', async () => {
  const collection = new DeletableCollection()
  const { management } = collectionManagement(collection)
  const server = startTestServer({
    identity: { role: 'curator' },
    management,
    provider: collection,
  })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/manage?tab=content`)
  try {
    await assertCurrentBuild(page)
    const investigation = await page.evaluate(
      async ({ one, two }: { one: { id: string; title: string }; two: typeof one }) => {
        const post = async (path: string, body: unknown) => {
          const response = await fetch(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          if (!response.ok) throw new Error(`${path} answered ${response.status}`)
          return response.json()
        }
        const { id } = await post('/api/t/marine/investigations', { name: 'Stock evidence' })
        for (const source of [one, two]) {
          await post(`/api/t/marine/investigations/${id}/evidence`, {
            resourceId: source.id,
            resourceTitle: source.title,
            passage: `A passage kept from ${source.title}.`,
          })
        }
        return id as string
      },
      {
        args: [{
          one: { id: RESOURCE_ONE.id, title: RESOURCE_ONE.title },
          two: { id: RESOURCE_TWO.id, title: RESOURCE_TWO.title },
        }],
      },
    )
    await openDelete(page, RESOURCE_TWO.id)
    await clickDialogButton(page, 'Delete document')
    await textShown(page, `Deleted “${RESOURCE_TWO.title}”.`, '[role=status]')

    await page.goto(`${server.url}/t/marine/investigations/${investigation}`)
    await page.waitForSelector('[data-evidence-source-gone]')
    const cards = await page.evaluate(() =>
      [...document.querySelectorAll('.rp-card')].filter((card) => card.querySelector('blockquote'))
        .map((card) => ({
          text: (card as HTMLElement).innerText,
          linked: !!card.querySelector('a[href*="/library/"]'),
          gone: !!card.querySelector('[data-evidence-source-gone]'),
        }))
    )
    const deleted = cards.find((card) => card.text.includes(RESOURCE_TWO.title))!
    const kept = cards.find((card) => card.text.includes(RESOURCE_ONE.title))!
    expect(deleted).toMatchObject({ gone: true, linked: false })
    expect(deleted.text).toContain('No longer in the Library')
    expect(deleted.text).toContain(`A passage kept from ${RESOURCE_TWO.title}.`)
    expect(kept).toMatchObject({ gone: false, linked: true })
    expect(await page.$('[role=alert]')).toBeNull()
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})
