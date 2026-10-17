import { expect } from '@std/expect'
import { renderToStaticMarkup } from 'react-dom/server'
import { createPortalLocale } from '../lib/portal-locale.tsx'
import { SaveEvidenceAction } from './SaveEvidence.tsx'

const defaults = {
  compact: false,
  saved: null,
  busy: false,
  current: null,
  label: 'Save',
  open: false,
  ui: createPortalLocale('en').ui,
  onSave: () => {},
  onPick: () => {},
}

Deno.test('document Save uses the standard outline size while compact evidence stays small', () => {
  const document = renderToStaticMarkup(<SaveEvidenceAction {...defaults} />)
  expect(document).toContain('rp-btn rp-btn-outline')
  expect(document).not.toContain('rp-btn-sm')
  expect(document).toContain('aria-pressed="false"')
  expect(document).toContain('aria-haspopup="dialog"')
  const compact = renderToStaticMarkup(<SaveEvidenceAction {...defaults} compact />)
  expect(compact).toContain('rp-btn-sm')
  const selection = renderToStaticMarkup(
    <SaveEvidenceAction {...defaults} label='Save selection' />,
  )
  expect(selection).toContain('Save selection')
  const busy = renderToStaticMarkup(
    <SaveEvidenceAction {...defaults} current={{ id: 'a', name: 'Review' }} busy />,
  )
  expect(busy).toContain('disabled=""')
  expect(busy).toContain('<svg')
  expect(busy).toContain('Saving…')
})

Deno.test('saved document control keeps a focusable pressed button and live confirmation', () => {
  const html = renderToStaticMarkup(<SaveEvidenceAction {...defaults} saved='Review' />)
  expect(html).toContain('<button')
  expect(html).toContain('aria-pressed="true"')
  expect(html).toContain('aria-disabled="true"')
  expect(html).not.toContain(' disabled=""')
  expect(html).not.toContain('aria-haspopup')
  expect(html).not.toContain('aria-expanded')
  expect(html).toContain('fill="currentColor"')
  expect(html).toContain('role="status"')
  expect(html).toContain('Saved to Review')
})

Deno.test('saving directly or opening the picker retains the current investigation behaviour', () => {
  let saves = 0
  let picks = 0
  const actions = {
    onSave: () => saves++,
    onPick: () => picks++,
  }
  const event = { preventDefault() {} }
  SaveEvidenceAction({ ...defaults, ...actions }).props.onClick(event)
  expect([saves, picks]).toEqual([0, 1])
  SaveEvidenceAction({
    ...defaults,
    ...actions,
    current: { id: 'a', name: 'Review' },
  }).props.onClick(event)
  expect([saves, picks]).toEqual([1, 1])
  SaveEvidenceAction({ ...defaults, ...actions, busy: true }).props.onClick(event)
  expect([saves, picks]).toEqual([1, 2])
})

Deno.test('saved and busy controls cannot trigger another write or reopen the picker', () => {
  for (const current of [null, { id: 'a', name: 'Review' }]) {
    const states = current
      ? [{ saved: 'Review', busy: false }, { saved: null, busy: true }]
      : [{ saved: 'Review', busy: false }]
    for (const state of states) {
      let activated = false
      let prevented = false
      const button = SaveEvidenceAction({
        ...defaults,
        ...state,
        current,
        onSave: () => activated = true,
        onPick: () => activated = true,
      })
      button.props.onClick({ preventDefault: () => prevented = true })
      expect(activated).toBe(false)
      expect(prevented).toBe(true)
    }
  }
})
