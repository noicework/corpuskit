/** Capability hints only: no question, answer, credential or error text is retained. */
export const STRUCTURED_REFUSAL_TTL_MS = 5 * 60_000
const MAX_HINTS = 256

export class StructuredRefusals {
  private readonly hints = new Map<string, number>()
  constructor(private readonly now: () => number = Date.now) {}

  refused(portal: string, model: string): boolean {
    const key = `${portal}|${model}`
    const until = this.hints.get(key)
    if (until === undefined) return false
    if (until > this.now()) return true
    this.hints.delete(key)
    return false
  }

  remember(portal: string, model: string): void {
    const now = this.now()
    for (const [key, until] of this.hints) if (until <= now) this.hints.delete(key)
    const key = `${portal}|${model}`
    this.hints.delete(key)
    if (this.hints.size >= MAX_HINTS) this.hints.delete(this.hints.keys().next().value!)
    this.hints.set(key, now + STRUCTURED_REFUSAL_TTL_MS)
  }

  forget(portal: string): void {
    for (const key of this.hints.keys()) if (key.startsWith(`${portal}|`)) this.hints.delete(key)
  }
}
