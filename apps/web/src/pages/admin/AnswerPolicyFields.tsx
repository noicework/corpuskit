import type { AnswerGuardrails } from '@research-portal/core'
import { usePortalLocale } from '../../lib/portal-locale.tsx'
import { Button } from '../../components/ui.tsx'

export function AnswerPolicyFields({ value, onChange, disabled, onReset }: {
  value: AnswerGuardrails
  onChange(value: AnswerGuardrails): void
  disabled: boolean
  onReset(): void
}) {
  const { ui } = usePortalLocale()
  const phrases = (field: 'outOfScope' | 'blockedTerms', label: string, help: string) => (
    <div className='min-w-0'>
      <label htmlFor={`policy-${field}`} className='block text-sm font-semibold text-ink'>
        {label}
      </label>
      <p id={`policy-${field}-help`} className='mt-1 text-sm text-ink-2'>{help}</p>
      <textarea
        id={`policy-${field}`}
        aria-describedby={`policy-${field}-help`}
        className='rp-input mt-2 w-full'
        rows={4}
        disabled={disabled}
        value={value[field].join('\n')}
        onChange={(e) => onChange({ ...value, [field]: e.target.value.split('\n') })}
      />
    </div>
  )
  return (
    <fieldset className='mt-6 min-w-0 border-t border-line pt-5' disabled={disabled}>
      <legend className='px-1 text-base font-semibold text-ink'>{ui('Answer guardrails')}</legend>
      <p className='mt-2 text-sm leading-relaxed text-ink-2'>
        {ui(
          'Only this portal is affected. Topics and terms are literal phrases, not regular expressions. Use one per line, up to 50 phrases of 120 characters each. Matching ignores case, character width and repeated spaces. Latin phrases match whole words; Japanese phrases match within text.',
        )}
      </p>
      <div className='mt-4 grid min-w-0 gap-5 xl:grid-cols-2'>
        {phrases(
          'outOfScope',
          ui('Out-of-scope topics'),
          ui('Matching questions are refused before any answer is generated.'),
        )}
        {phrases(
          'blockedTerms',
          ui('Blocked terms in answers'),
          ui('If an answer contains one of these phrases, the whole answer is withheld.'),
        )}
      </div>
      <div className='mt-5 grid min-w-0 gap-5 xl:grid-cols-2'>
        <label className='block min-w-0 text-sm font-semibold text-ink' htmlFor='policy-refusal'>
          {ui('Question refusal message')}
          <textarea
            id='policy-refusal'
            className='rp-input mt-2 w-full font-normal'
            rows={3}
            maxLength={500}
            value={value.refusalMessage}
            onChange={(e) => onChange({ ...value, refusalMessage: e.target.value })}
          />
        </label>
        <label className='block min-w-0 text-sm font-semibold text-ink' htmlFor='policy-withheld'>
          {ui('Withheld answer message')}
          <textarea
            id='policy-withheld'
            className='rp-input mt-2 w-full font-normal'
            rows={3}
            maxLength={500}
            value={value.withheldMessage}
            onChange={(e) => onChange({ ...value, withheldMessage: e.target.value })}
          />
        </label>
      </div>
      <label className='mt-5 block text-sm font-semibold text-ink' htmlFor='policy-contact'>
        {ui('Portal contact line')}
      </label>
      <p id='policy-contact-help' className='mt-1 text-sm text-ink-2'>
        {ui(
          'Plain text added to both messages, such as a team email address. Up to 240 characters.',
        )}
      </p>
      <input
        id='policy-contact'
        className='rp-input mt-2 w-full'
        type='text'
        maxLength={240}
        aria-describedby='policy-contact-help'
        value={value.contactLine}
        onChange={(e) => onChange({ ...value, contactLine: e.target.value })}
      />
      <label className='mt-5 block text-sm font-semibold text-ink' htmlFor='policy-length'>
        {ui('Maximum answer length')}
      </label>
      <p id='policy-length-help' className='mt-1 text-sm text-ink-2'>
        {ui(
          '100 to 20,000 characters, including spaces and citation markers. Leave empty for no portal cap. Longer answers are withheld whole to preserve citation accuracy. Policy messages are exempt.',
        )}
      </p>
      <input
        id='policy-length'
        className='rp-input mt-2 w-full sm:max-w-xs'
        type='number'
        min={100}
        max={20000}
        step={1}
        aria-describedby='policy-length-help'
        value={value.maxAnswerLength ?? ''}
        onChange={(e) =>
          onChange({
            ...value,
            maxAnswerLength: e.target.value === '' ? null : Number(e.target.value),
          })}
      />
      <p className='mt-3 text-sm leading-relaxed text-ink-2'>
        {ui(
          'With answer checks enabled, text waits until the full answer has been checked. Refused questions and withheld answers are counted in Insights.',
        )}
      </p>
      <Button className='mt-3' variant='outline' disabled={disabled} onClick={onReset}>
        {ui('Reset guardrails')}
      </Button>
    </fieldset>
  )
}
