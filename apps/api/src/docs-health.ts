/**
 * Documentation-scoped probe: is Help's index actually populated?
 *
 * Probes each portal's documentation-scoped search at boot and after every
 * ingest, and reports the result on `/api/health` as `docs`/`docsOk`, so a
 * box provisioned without documentation ingestion is caught rather than
 * silently answering "the help documentation does not cover this".
 * Serves: R20 (P7-08, P8-12, P7-31); PR #4.
 */
import type { TenantConfig } from '@research-portal/core'
import type { RetrievalProvider } from '@research-portal/retrieval'

/**
 * Documentation readiness check.
 *
 * The Help section (its search and its assistant) retrieves ONLY from the
 * in-app documentation ingested into each portal's knowledge box, through the
 * documentation-scoped stored search configuration. A portal whose box was
 * provisioned without that ingestion looks perfectly healthy - every route
 * answers 200 - while Help returns nothing for every query and the assistant
 * says "the help documentation does not cover this" for questions the
 * authored pages answer in full (persona findings P7-08 and P8-12). Nothing
 * in the request path can tell the difference between "no page matches" and
 * "no pages were ever ingested".
 *
 * So the server probes each bound portal with a documentation-scoped search
 * for a phrase every authored page carries, records how many documentation
 * resources came back, and reports it on `/api/health` as `docs`. A zero is
 * logged loudly at boot and after every re-check so it never passes quietly.
 */

/** A phrase every authored documentation page contains, so any indexed page matches. */
export const DOCS_PROBE_QUERY = 'portal'

export interface DocsTenantStatus {
  /** Documentation resources the scoped search returned for the probe. */
  documents: number
  ok: boolean
  checkedAt: string
  /** Set when the probe itself failed (box offline, binding missing). */
  error?: string
}

export type DocsStatus = Record<string, DocsTenantStatus>

export interface DocsHealthOptions {
  /** Tenants to probe; only those with a knowledge box binding are checked. */
  tenants: () => TenantConfig[]
  /** Whether a tenant has a box to probe. Unbound portals are skipped, not failed. */
  isBound: (slug: string) => boolean
  provider: Pick<RetrievalProvider, 'search'>
  /** Where the loud failure goes; defaults to console.error. */
  log?: (message: string) => void
  now?: () => Date
}

/**
 * Holds the latest documentation readiness snapshot and knows how to refresh
 * it. `check()` is called at boot and after every documentation ingestion;
 * `snapshot()` is what `/api/health` reports.
 */
export class DocsHealth {
  private status: DocsStatus = {}
  constructor(private readonly opts: DocsHealthOptions) {}

  snapshot(): DocsStatus {
    return { ...this.status }
  }

  /** True when every checked portal has documentation; also true with nothing to check. */
  ok(): boolean {
    return Object.values(this.status).every((s) => s.ok)
  }

  /** Probe one portal and record the result. */
  async checkTenant(config: TenantConfig): Promise<DocsTenantStatus> {
    const log = this.opts.log ?? ((message: string) => console.error(message))
    const checkedAt = (this.opts.now ?? (() => new Date()))().toISOString()
    let result: DocsTenantStatus
    try {
      const results = await this.opts.provider.search(config, DOCS_PROBE_QUERY, {
        docScope: true,
      })
      const documents = results.resources.length
      result = { documents, ok: documents > 0, checkedAt }
    } catch (err) {
      result = {
        documents: 0,
        ok: false,
        checkedAt,
        error: err instanceof Error ? err.message : 'documentation probe failed',
      }
    }
    this.status[config.slug] = result
    if (!result.ok) {
      log(
        `[docs] DOCUMENTATION NOT INDEXED for portal "${config.slug}": the documentation-scoped ` +
          `search returned ${result.documents} documents${
            result.error ? ` (${result.error})` : ''
          }. Help search and the Help assistant will answer nothing until an administrator ` +
          `runs POST /api/admin/t/${config.slug}/docs/ingest.`,
      )
    }
    return result
  }

  /** Probe every bound portal. Never throws - a failed probe is a recorded failure. */
  async check(): Promise<DocsStatus> {
    for (const config of this.opts.tenants()) {
      if (!this.opts.isBound(config.slug)) continue
      await this.checkTenant(config)
    }
    return this.snapshot()
  }
}
