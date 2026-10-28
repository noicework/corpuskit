import type { ResourceSummary } from '@research-portal/core'
import type { ExportResource } from '../../provider.ts'

type Classification = { labelset?: string; label?: string; cancelled_by_user?: boolean }
interface ExportRaw {
  created?: string
  modified?: string
  metadata?: { status?: string }
  extra?: { metadata?: object }
  usermetadata?: { classifications?: Classification[] }
  computedmetadata?: {
    classifications?: Classification[]
    field_classifications?: { classifications?: Classification[] }[]
  }
  classifications?: Classification[]
  data?: Record<
    string,
    Record<string, {
      value?: { file?: { content_type?: string } }
    }>
  >
}

/** Never copy provider file pointers: they can carry storage credentials. */
export function exportResource(resource: ResourceSummary, raw: ExportRaw): ExportResource {
  const labels = new Map<string, { labelset: string; label: string }>()
  for (
    const item of [
      ...(raw.usermetadata?.classifications ?? []),
      ...(raw.computedmetadata?.classifications ?? []),
      ...(raw.computedmetadata?.field_classifications ?? []).flatMap((f) =>
        f.classifications ?? []
      ),
      ...(raw.classifications ?? []),
    ]
  ) {
    if (item.labelset && item.label && !item.cancelled_by_user) {
      labels.set(JSON.stringify([item.labelset, item.label]), {
        labelset: item.labelset,
        label: item.label,
      })
    }
  }
  const files: ExportResource['files'] = []
  for (const fields of Object.values(raw.data ?? {})) {
    for (const [fieldId, field] of Object.entries(fields)) {
      if (field.value?.file) files.push({ fieldId, contentType: field.value.file.content_type })
    }
  }
  return {
    resource,
    metadata: { ...raw.extra?.metadata },
    labels: [...labels.values()],
    created: raw.created,
    modified: raw.modified,
    status: raw.metadata?.status,
    files,
  }
}
