import { z } from 'zod'

/** Attribution for a result in the shared search, without credentials or peer addresses. */
export const SearchSourceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(['hosted', 'peer']),
  transport: z.enum(['hosted', 'kb', 'mcp']),
})

export const SearchSourceFailureSchema = SearchSourceSchema.extend({
  reason: z.enum(['timeout', 'unauthorised', 'error']),
})

export type SearchSource = z.infer<typeof SearchSourceSchema>
export type SearchSourceFailure = z.infer<typeof SearchSourceFailureSchema>
