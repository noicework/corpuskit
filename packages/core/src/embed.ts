import { z } from 'zod'

/** Exact HTTPS origins only. No credentials, paths, queries, wildcards or opaque origins. */
export const EmbeddingOriginSchema = z.string().trim().max(300).transform((value, context) => {
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' ||
      url.search || url.hash || value.includes('*') || !/^https:\/\/[^/]+\/?$/i.test(value)
    ) throw new Error('Invalid origin')
    return url.origin
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter an HTTPS origin only' })
    return z.NEVER
  }
})

export const EmbeddingSettingsSchema = z.object({
  enabled: z.boolean(),
  allowedOrigins: EmbeddingOriginSchema.array().max(20).transform((values) => [...new Set(values)]),
  /** Federated offers the partner switch; own keeps every ask inside this collection. */
  defaultView: z.enum(['own', 'federated']),
}).strict()

export type EmbeddingSettings = z.infer<typeof EmbeddingSettingsSchema>
