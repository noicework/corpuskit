import { usePortalLocale } from '../../lib/portal-locale.tsx'
import type { Message } from './shared.ts'

/** ok / error inline panel, shared by every admin action. */
export function MessagePanel(
  { message, className = '' }: { message: Message; className?: string },
) {
  const { error } = usePortalLocale()
  const tone = message.tone === 'ok'
    ? {
      background: 'var(--rp-ok-bg)',
      color: 'var(--rp-ok-ink)',
      borderColor: 'var(--rp-ok-line)',
    }
    : {
      background: 'var(--rp-bad-bg)',
      color: 'var(--rp-bad-ink)',
      borderColor: 'var(--rp-bad-line)',
    }

  return (
    <div
      role={message.tone === 'error' ? 'alert' : 'status'}
      className={`rounded-[calc(var(--rp-radius)+4px)] border px-4 py-3 text-sm ${className}`}
      style={tone}
    >
      {message.tone === 'error'
        ? error(message.text, 'The action failed. Please try again.')
        : message.text}
    </div>
  )
}
