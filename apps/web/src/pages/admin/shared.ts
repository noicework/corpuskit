/** Shared styling and small types used across the admin page's subcomponents. */

export const inputClass = 'rp-input'

export type Message = { tone: 'ok' | 'error'; text: string }

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}
