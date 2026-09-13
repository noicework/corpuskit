import {
  type AuthorityContext,
  type AuthorityController,
  StaleAuthorityError,
} from '../api/access-lifecycle.ts'

export interface ResearchExportAuthority {
  controller: AuthorityController
  context: AuthorityContext
  slug: string
  signal?: AbortSignal
}
export interface ResearchFile {
  parts: BlobPart[]
  type: string
  filename: string
}

/** Capture when the protected content is read, never after an asynchronous producer completes. */
export function researchExportAuthority(
  controller: AuthorityController,
  slug: string,
): ResearchExportAuthority {
  return { controller, context: controller.context, slug }
}

/** No browser output exists until the entire result passes current export authority. */
export async function exportResearchFile(
  authority: ResearchExportAuthority,
  producer: (signal: AbortSignal) => ResearchFile | Promise<ResearchFile>,
): Promise<string> {
  const { controller, context, slug } = authority
  const assert = () => {
    authority.signal?.throwIfAborted()
    controller.assertCurrent(context)
    if (!controller.can('portal.export', { kind: 'portal', slug })) throw new StaleAuthorityError()
  }
  assert()
  const request = controller.beginRequest(authority.signal)
  let url: string | null = null
  let link: HTMLAnchorElement | null = null
  const clear = () => {
    link?.remove()
    link = null
    if (url) URL.revokeObjectURL(url)
    url = null
  }
  const unregister = controller.registerCleanup(clear)
  try {
    const file = await producer(request.signal)
    request.assertCurrent()
    assert()
    if (!file.filename.trim() || file.parts.length === 0) throw new Error('Nothing to export.')
    const blob = new Blob(file.parts, { type: file.type })
    if (blob.size === 0) throw new Error('Nothing to export.')
    assert()
    url = URL.createObjectURL(blob)
    assert()
    link = document.createElement('a')
    link.href = url
    link.download = file.filename
    document.body.appendChild(link)
    assert()
    link.click()
    return file.filename
  } finally {
    clear()
    unregister()
    request.finish()
  }
}

/** Keep the print window owned until printing finishes or the caller loses authority. */
export async function printResearchHtml(
  authority: ResearchExportAuthority,
  producer: (signal: AbortSignal) => string | Promise<string>,
): Promise<boolean> {
  const { controller, context, slug } = authority
  const assert = () => {
    authority.signal?.throwIfAborted()
    controller.assertCurrent(context)
    if (!controller.can('portal.export', { kind: 'portal', slug })) throw new StaleAuthorityError()
  }
  assert()
  const request = controller.beginRequest(authority.signal)
  let win: Window | null = null
  let releasePrint: (() => void) | undefined
  const clear = () => {
    releasePrint?.()
    win?.close()
    win = null
  }
  const unregister = controller.registerCleanup(clear)
  request.signal.addEventListener('abort', clear, { once: true })
  let abortWait: (() => void) | undefined
  const cancelled = new Promise<never>((_resolve, reject) => {
    abortWait = () => reject(new StaleAuthorityError())
    request.signal.addEventListener('abort', abortWait, { once: true })
  })
  try {
    const html = await Promise.race([producer(request.signal), cancelled])
    request.assertCurrent()
    assert()
    if (!html.trim()) throw new Error('Nothing to export.')
    win = globalThis.open('', '_blank')
    if (!win) return false
    assert()
    win.document.write(html)
    win.document.close()
    await Promise.race([win.document.fonts.ready, cancelled])
    request.assertCurrent()
    assert()
    if (!win || win.closed) return false
    win.focus()
    assert()
    const printed = new Promise<void>((resolve) => {
      releasePrint = resolve
      win!.addEventListener('afterprint', () => resolve(), { once: true })
      win!.addEventListener('pagehide', () => resolve(), { once: true })
    })
    win.print()
    await Promise.race([printed, cancelled])
    request.assertCurrent()
    assert()
    return true
  } finally {
    clear()
    unregister()
    request.signal.removeEventListener('abort', clear)
    if (abortWait) request.signal.removeEventListener('abort', abortWait)
    request.finish()
  }
}
