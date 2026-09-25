import { BrandingSchema } from '@research-portal/core'
import { z } from 'zod'

const safeMetadataSchema = z.object({
  slug: z.string(),
  status: z.enum(['active', 'read_only', 'suspended']).default('active'),
  accessMode: z.enum(['public', 'authenticated', 'restricted']),
  branding: BrandingSchema.pick({
    productName: true,
    organisation: true,
    logoUrl: true,
    colours: true,
    paletteId: true,
  }).extend({
    logoUrl: z.string().nullable().optional().transform((value) => value ?? undefined),
    paletteId: BrandingSchema.shape.paletteId.nullable().transform((value) => value ?? undefined),
  }),
})

/** Project every response to public branding, including a suspended portal's 423. */
export async function readSafePortalMetadata(response: Response, slug: string) {
  const body: unknown = await response.json()
  const paused = response.status === 423 && body && typeof body === 'object' &&
    'error' in body && body.error === 'portal_suspended' &&
    'status' in body && body.status === 'suspended'
  if (!response.ok && !paused) throw new Error('Safe metadata unavailable')
  const value = safeMetadataSchema.parse(body)
  if (value.slug !== slug) throw new Error('Mismatched portal')
  return value
}

/** Access and hosting refusals are answers, not faults: retry only what may be transient. */
export function retryTenantConfig(failureCount: number, error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status
  if (typeof status === 'number' && [401, 403, 404, 423].includes(status)) return false
  return failureCount < 3
}
