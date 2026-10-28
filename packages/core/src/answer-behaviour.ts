import { z } from 'zod'

const phrases = z.string().trim().min(1).max(120).array().max(50)

/** Private portal settings, stored with its configuration, never in the public projection. */
export const AnswerGuardrailsSchema = z.object({
  outOfScope: phrases.default([]),
  blockedTerms: phrases.default([]),
  refusalMessage: z.string().trim().min(1).max(500).default(
    'This portal cannot answer questions about that topic.',
  ),
  withheldMessage: z.string().trim().min(1).max(500).default(
    'This answer has been withheld under the portal answer policy.',
  ),
  contactLine: z.string().trim().max(240).default(''),
  /** Unicode characters, including spaces and citation markers. Null means no portal cap. */
  maxAnswerLength: z.number().int().min(100).max(20000).nullable().default(null),
}).strict()

export const PortalPromptsSchema = z.object({
  ask: z.string().max(2000).optional(),
  images: z.boolean().optional(),
  uncitedAnswers: z.enum(['show', 'refuse']).optional(),
  guardrails: AnswerGuardrailsSchema.optional(),
}).strict()

export type PortalPrompts = z.infer<typeof PortalPromptsSchema>
export type AnswerGuardrails = z.infer<typeof AnswerGuardrailsSchema>
export type GuardrailAction = 'question-refused' | 'answer-withheld' | 'length-withheld'
