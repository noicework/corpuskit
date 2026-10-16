import type { Labelset } from '@research-portal/core'
import type { Locale } from './portal-locale.tsx'

/** Only the unchanged built-in classifier names are app copy; custom titles remain authored. */
export function labelsetDisplayTitle(labelset: Labelset, ui: Locale['ui']): string {
  if (labelset.id === 'topic' && labelset.title === 'Topic') return ui('Topic')
  if (labelset.id === 'kind' && labelset.title === 'Kind') return ui('Kind')
  return labelset.title
}
