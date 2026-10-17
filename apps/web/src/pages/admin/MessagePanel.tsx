import { usePortalLocale } from '../../lib/portal-locale.tsx'
import type { Message } from './shared.ts'
import { AlertCircle, CheckCircle } from '../../components/icons.tsx'

/** ok / error inline panel, shared by every admin action. */
export function MessagePanel(
  { message, className = '' }: { message: Message; className?: string },
) {
  const locale = usePortalLocale()
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
      className={`flex items-start gap-2 rounded-[var(--rp-radius)] border px-4 py-3 text-sm ${className}`}
      style={tone}
    >
      {message.tone === 'error'
        ? <AlertCircle size='sm' className='mt-0.5 shrink-0' />
        : <CheckCircle size='sm' className='mt-0.5 shrink-0' />}
      <span className='min-w-0 break-words'>
        {message.render
          ? message.render(locale)
          : message.tone === 'error'
          ? locale.error(message.text, 'The action failed. Please try again.')
          : message.text}
      </span>
    </div>
  )
}
