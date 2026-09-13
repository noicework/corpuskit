import type { Scope } from '@research-portal/core'
import { type AuthorityController, StaleAuthorityError } from '../api/access-lifecycle.ts'
import {
  AuditError,
  type AuditExportPage,
  type AuditFormat,
  type AuditQuery,
  exportAuditPage,
} from '../api/audit.ts'

export type AuditDownloadResult = Pick<AuditExportPage, 'nextCursor' | 'snapshot' | 'complete'>
export interface AuditDownloadSink {
  create(blob: Blob): string
  click(url: string, filename: string): void
  revoke(url: string): void
}
const browserSink: AuditDownloadSink = {
  create: (blob) => URL.createObjectURL(blob),
  click: (url, filename) => {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    document.body.append(anchor)
    try {
      anchor.click()
    } finally {
      anchor.remove()
    }
  },
  revoke: (url) => URL.revokeObjectURL(url),
}

/** One immutable selection owns at most one pending page and its transient object URL. */
export class AuditDownload {
  #generation = 0
  #pending: AbortController | null = null
  #url: string | null = null
  #selection: { scope: Scope; filters: Omit<AuditQuery, 'cursor'>; format: AuditFormat }
  #context
  #unregister: () => void
  constructor(
    private readonly authority: AuthorityController,
    scope: Scope,
    filters: Omit<AuditQuery, 'cursor'>,
    format: AuditFormat,
    private readonly sink: AuditDownloadSink = browserSink,
  ) {
    this.#context = authority.context
    this.#selection = Object.freeze({
      scope: Object.freeze({ ...scope }),
      filters: Object.freeze({ ...filters }),
      format,
    })
    this.#unregister = authority.registerCleanup(() => this.stop())
  }
  stop() {
    this.#generation++
    this.#pending?.abort()
    this.#pending = null
    if (this.#url) this.sink.revoke(this.#url)
    this.#url = null
  }
  dispose() {
    this.stop()
    this.#unregister()
  }
  async download(previous?: AuditDownloadResult): Promise<AuditDownloadResult> {
    this.stop()
    const token = this.#generation, abort = new AbortController()
    this.#pending = abort
    const { scope, filters, format } = this.#selection
    let created: string | null = null
    const assert = () => {
      abort.signal.throwIfAborted()
      this.authority.assertCurrent(this.#context)
      if (token !== this.#generation || !this.authority.can('audit.export', scope)) {
        throw new StaleAuthorityError()
      }
    }
    try {
      assert()
      if (previous && (!previous.nextCursor || previous.complete)) throw new AuditError()
      const page = await exportAuditPage(
        scope,
        filters,
        format,
        previous?.nextCursor ?? undefined,
        { authority: this.authority, context: this.#context, signal: abort.signal },
      )
      assert()
      if (
        previous &&
        (page.snapshot.id !== previous.snapshot.id ||
          page.snapshot.expiresAt !== previous.snapshot.expiresAt)
      ) throw new AuditError()
      this.#url = this.sink.create(
        new Blob([page.bytes as Uint8Array<ArrayBuffer>], { type: page.contentType }),
      )
      created = this.#url
      assert()
      this.sink.click(
        this.#url,
        `audit-${scope.kind === 'portal' ? scope.slug : 'platform'}-${
          page.complete ? 'complete' : 'partial'
        }.${format}`,
      )
      assert()
      return { nextCursor: page.nextCursor, snapshot: page.snapshot, complete: page.complete }
    } finally {
      if (created && this.#url === created) {
        this.sink.revoke(created)
        this.#url = null
      }
      if (token === this.#generation) this.stop()
    }
  }
}
