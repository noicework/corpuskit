import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { extractedTextHint, extractedTextMode, extractedTextToggleLabel } from './extracted-text.ts'

describe('extracted text on a PDF', () => {
  it('waits behind its switch while the PDF is on screen', () => {
    expect(extractedTextMode({ hasExtractedText: true, pdfAvailable: true })).toBe('switch')
  })

  it('stays behind the switch even when a citation passage brought the reader here', () => {
    // The regression this guards: arriving from a citation used to auto-expand
    // the machine text under the viewer, burying the PDF the citation points at.
    expect(extractedTextMode({ hasExtractedText: true, pdfAvailable: true })).not.toBe('always')
  })

  it('is shown outright when the PDF cannot be displayed, since it is the only reading', () => {
    expect(extractedTextMode({ hasExtractedText: true, pdfAvailable: false })).toBe('always')
  })

  it('is not offered at all when there is no extracted text', () => {
    expect(extractedTextMode({ hasExtractedText: false, pdfAvailable: true })).toBe('hidden')
    expect(extractedTextMode({ hasExtractedText: false, pdfAvailable: false })).toBe('hidden')
  })
})

describe('the extracted text switch', () => {
  it('states the action it performs in both states', () => {
    expect(extractedTextToggleLabel(false)).toBe('Show extracted text')
    expect(extractedTextToggleLabel(true)).toBe('Hide extracted text')
  })

  it('says a match is waiting inside without opening the text to say so', () => {
    expect(extractedTextHint({ open: false, hasMatch: true })).toContain('Your match appears in it')
    expect(extractedTextHint({ open: false, hasMatch: false })).not.toContain('Your match')
  })

  it('names the PDF as the document once the text is open', () => {
    expect(extractedTextHint({ open: true, hasMatch: true })).toContain(
      'The PDF above is the document itself',
    )
  })

  it('is written in Australian English with no em dashes', () => {
    const copy = [
      extractedTextToggleLabel(true),
      extractedTextToggleLabel(false),
      extractedTextHint({ open: true, hasMatch: true }),
      extractedTextHint({ open: false, hasMatch: true }),
      extractedTextHint({ open: false, hasMatch: false }),
    ].join(' ')
    expect(copy).not.toContain('—')
  })
})
