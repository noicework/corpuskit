/** Export only domain records. Bindings, identity sessions and environment are never inputs. */
const sensitiveField =
  /secret|token|password|passcode|credential|authori[sz]ation|cookie|sealed|private.?key|api.?key|(?:session|signing|encryption|serviceaccount)key|^key$|^hash$|^prefix$/i
const sensitiveQuery =
  /secret|token|password|passcode|credential|auth|key|signature|^sig$|^code$|^s[epvrt]$|^policy$|^expires$|^x-amz-|^x-goog-/i

function safeUrl(value: string): string {
  try {
    const relative = value.startsWith('/')
    const url = new URL(value, 'https://export.invalid')
    if (!['https:', 'http:'].includes(url.protocol)) return '[redacted URL]'
    url.username = ''
    url.password = ''
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (sensitiveQuery.test(key)) url.searchParams.delete(key)
    }
    return relative ? `${url.pathname}${url.search}` : url.toString()
  } catch {
    return '[redacted URL]'
  }
}

export function redactExportText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s<>"']+/gi, safeUrl)
    .replace(/\bck_(?:mcp_)?[A-Za-z0-9_-]{20,}/g, '[redacted key]')
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:enc:v1:|Operator\s+)[^\s"'<>]+/gi, '[redacted credential]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted token]')
    .replace(
      /\b(?:secret|token|password|passcode|api[_-]?key)["']?\s*[:=]\s*["']?[^\s"'<>]+/gi,
      '[redacted]',
    )
}

/** Schemas/explicit projections remove unknown authority fields before this defence in depth. */
export function redactExport(value: unknown, field = '', depth = 0): unknown {
  if (depth > 32) return '[redacted depth]'
  if (typeof value === 'string') {
    return redactExportText(/url$/i.test(field) ? safeUrl(value) : value)
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map((item) => redactExport(item, field, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !sensitiveField.test(key))
        .map(([key, item]) => [redactExportText(key), redactExport(item, key, depth + 1)]),
    )
  }
  return undefined
}
