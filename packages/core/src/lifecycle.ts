import { z } from 'zod'

export const PortalStatusSchema = z.enum(['active', 'read_only', 'suspended'])
export type PortalStatus = z.infer<typeof PortalStatusSchema>

const LimitSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const PortalLimitsSchema = z.object({
  maxResources: LimitSchema.optional(),
  maxBytes: LimitSchema.optional(),
  asksPerDay: LimitSchema.optional(),
  agentsEnabled: z.boolean().optional(),
}).strict()
export type PortalLimits = z.infer<typeof PortalLimitsSchema>

export const PortalLifecycleSchema = z.object({
  status: PortalStatusSchema,
  limits: PortalLimitsSchema.nullable(),
  updatedAt: z.string().datetime().nullable(),
}).strict()
export type PortalLifecycle = z.infer<typeof PortalLifecycleSchema>

/** Control characters and bidirectional overrides could disguise an audit record's text. */
function hasHiddenCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true
    if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) return true
  }
  return false
}

/** Free-text audit notes cannot carry recognisable credential forms or hidden characters. */
export function isSafeLifecycleNote(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 1000 && !hasHiddenCharacter(value) &&
    !/\b(?:bearer|operator)\s+[A-Za-z0-9_.+/=-]{16,}/i.test(value) &&
    !/\benc:v1:/i.test(value) &&
    !/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(value) &&
    !/\b(?:token|password|secret|api[_ -]?key)\s*[:=]\s*\S+/i.test(value) &&
    !/\bck_[A-Za-z0-9_-]{43}\b/.test(value)
}

export const PortalLifecycleInputSchema = z.object({
  status: PortalStatusSchema,
  limits: PortalLimitsSchema.nullable(),
  note: z.string().refine(isSafeLifecycleNote, 'Invalid lifecycle note').optional(),
}).strict()

export interface PortalAskUsage {
  asksToday: number
  asks30d: number
  lastActivityAt: string | null
}

export interface PortalAskQuota {
  limit: number
  resetsAt: string
}
