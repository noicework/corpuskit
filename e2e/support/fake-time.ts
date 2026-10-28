/** Local timer double, avoiding an additional test dependency and lockfile change. */
export class FakeTime {
  private readonly realSetTimeout = globalThis.setTimeout
  private readonly realClearTimeout = globalThis.clearTimeout
  private readonly realNow = Date.now
  private now = 0
  private nextId = 1
  private readonly timers = new Map<number, { at: number; run: () => void }>()

  constructor() {
    Date.now = () => this.now
    globalThis.setTimeout =
      ((callback: (...args: unknown[]) => void, ms = 0, ...args: unknown[]) => {
        const id = this.nextId++
        this.timers.set(id, { at: this.now + Math.max(0, ms), run: () => callback(...args) })
        return id
      }) as typeof setTimeout
    globalThis.clearTimeout = ((id?: number) => {
      if (id !== undefined) this.timers.delete(id)
    }) as typeof clearTimeout
  }

  /** Flush the promise queue before advancing, and after each scheduled callback. */
  async tickAsync(ms: number): Promise<void> {
    const target = this.now + ms
    const flush = () => new Promise<void>((resolve) => this.realSetTimeout(resolve, 0))
    await flush()
    for (;;) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!next) break
      this.now = next[1].at
      this.timers.delete(next[0])
      next[1].run()
      await flush()
    }
    this.now = target
    await flush()
  }

  [Symbol.dispose](): void {
    Date.now = this.realNow
    globalThis.setTimeout = this.realSetTimeout
    globalThis.clearTimeout = this.realClearTimeout
    this.timers.clear()
  }
}
