/** Remove credentials and network/session identifiers while retaining the research question. */
export function redactAnswerRecordText(value: string): string {
  return value
    .replace(/\b(?:Bearer|Operator)\s+[A-Za-z0-9_.+/=-]+/gi, '[redacted credential]')
    .replace(/\bck_[A-Za-z0-9_-]{43}\b/g, '[redacted credential]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted credential]')
    .replace(
      /\b(?:token|password|secret|api[_ -]?key|session[_ -]?id)\s*[:=]\s*[^\s,;]+/gi,
      '[redacted identifier]',
    )
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted address]')
    .replace(/(?<![\w:])(?:[a-f\d]{0,4}:){2,}[a-f\d:.]*(?!\w)/gi, (candidate) => {
      try {
        new URL(`http://[${candidate}]/`)
        return '[redacted address]'
      } catch {
        return candidate
      }
    })
    .replace(/https?:\/\/[^\s"<>]+/gi, (url) => {
      try {
        const parsed = new URL(url)
        parsed.username = ''
        parsed.password = ''
        parsed.search = ''
        parsed.hash = ''
        return parsed.toString()
      } catch {
        return '[redacted URL]'
      }
    })
}
