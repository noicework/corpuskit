import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { answerModeParam, readAnswerMode } from './search-mode.ts'

describe('readAnswerMode', () => {
  it('defaults to an answered search when the param is absent', () => {
    expect(readAnswerMode(new URLSearchParams(''))).toBe(true)
    expect(readAnswerMode(new URLSearchParams('q=carp'))).toBe(true)
  })

  it('reads results-only from the exact opt-out value', () => {
    expect(readAnswerMode(new URLSearchParams('answer=0'))).toBe(false)
    expect(readAnswerMode(new URLSearchParams('q=carp&answer=0'))).toBe(false)
  })

  it('keeps older opt-in links working, so a shared ?answer=1 still answers', () => {
    expect(readAnswerMode(new URLSearchParams('answer=1'))).toBe(true)
    expect(readAnswerMode(new URLSearchParams('q=carp&answer=1'))).toBe(true)
  })

  it('treats any other value as the answered default rather than guessing', () => {
    expect(readAnswerMode(new URLSearchParams('answer=true'))).toBe(true)
    expect(readAnswerMode(new URLSearchParams('answer='))).toBe(true)
  })
})

describe('answerModeParam', () => {
  it('clears the param for the answered default so the URL stays clean', () => {
    expect(answerModeParam(true)).toBe(null)
  })

  it('records the results-only opt-out explicitly', () => {
    expect(answerModeParam(false)).toBe('0')
  })

  it('round-trips through a URLSearchParams patch', () => {
    const params = new URLSearchParams('q=carp')
    const optOut = answerModeParam(false)
    if (optOut === null) params.delete('answer')
    else params.set('answer', optOut)
    expect(params.toString()).toBe('q=carp&answer=0')
    expect(readAnswerMode(params)).toBe(false)

    const back = answerModeParam(true)
    if (back === null) params.delete('answer')
    else params.set('answer', back)
    expect(params.toString()).toBe('q=carp')
    expect(readAnswerMode(params)).toBe(true)
  })
})
