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
    const blob = new Blob(file.parts, { type: file.type })
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
