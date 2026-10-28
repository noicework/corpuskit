import { type UsageReport, UsageReportSchema } from '@research-portal/core'
import { AdminAccessError, adminFetch, type AdminRequestAccess } from './break-glass.ts'
import { adminRequest, ApiError } from './client.ts'

/** The monthly usage report's address (docs/USAGE-REPORTS.md). */
function usagePath(slug: string, month: string, format: 'json' | 'csv'): string {
  const query = new URLSearchParams({ month, ...(format === 'csv' ? { format } : {}) })
  return `/api/admin/t/${encodeURIComponent(slug)}/insights/usage?${query}`
}

/** One portal's usage for a month, for the printable report. */
export async function getUsageReport(
  slug: string,
  month: string,
  access: AdminRequestAccess,
): Promise<UsageReport> {
  const parsed = UsageReportSchema.safeParse(
    await adminRequest<unknown>(usagePath(slug, month, 'json'), access),
  )
  // A report for another portal or month is no answer to this request.
  if (!parsed.success || parsed.data.slug !== slug || parsed.data.month !== month) {
    throw new AdminAccessError()
  }
  return parsed.data
}

/** The month's CSV as the server wrote it, and the name to save it under. */
export async function getUsageCsv(
  slug: string,
  month: string,
  access: AdminRequestAccess,
): Promise<{ blob: Blob; filename: string }> {
  const response = await adminFetch(access, usagePath(slug, month, 'csv'), {
    headers: { accept: 'text/csv' },
  })
  if (!response.ok) {
    const body: { message?: unknown } | null = await response.json().catch(() => null)
    throw new ApiError(
      response.status,
      typeof body?.message === 'string' ? body.message : 'Could not download the usage report.',
    )
  }
  if (response.headers.get('content-type')?.split(';')[0]?.trim() !== 'text/csv') {
    throw new AdminAccessError()
  }
  const text = await response.text()
  if (!text.startsWith('# CorpusKit usage report')) throw new AdminAccessError()
  return {
    blob: new Blob([text], { type: 'text/csv;charset=utf-8' }),
    filename: `usage-${slug}-${month}.csv`,
  }
}
