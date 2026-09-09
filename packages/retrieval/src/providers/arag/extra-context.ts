import type { AskOptions } from '../../provider.ts'

/** Build the exact wire order and provenance together. Filtering or truncating
 * these arrays separately could silently bind an alias to the wrong document.
 * Legacy anonymous strings stay anonymous; only server-created source entries
 * can acquire a resource identity.
 */
export function prepareExtraContext(opts: Pick<AskOptions, 'extraContext' | 'sourceContext'>) {
  const candidates = [
    ...(opts.extraContext ?? []).map((text) => ({ text, resourceId: undefined })),
    ...(opts.sourceContext ?? []),
  ]
  const texts: string[] = []
  const resources = new Map<string, string>()
  for (const entry of candidates) {
    if (!entry.text.trim()) continue
    if (texts.length >= 12) break
    const alias = `USER_CONTEXT_${texts.length}`
    texts.push(entry.text)
    if (entry.resourceId) resources.set(alias, entry.resourceId)
  }
  return { texts, resources }
}
