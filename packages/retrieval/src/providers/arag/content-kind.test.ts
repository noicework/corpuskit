import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  detectContentKind,
  isDisplayableResource,
  isOfficeMime,
  looksLikeSystemFileTitle,
  selectPreviewFile,
} from './index.ts'

/**
 * The resource-detail redesign's file/kind resolution: picking a viewer kind
 * from every mime hint (not `icon` alone, so a PDF whose icon never populated
 * still renders), spotting Office mimes and their renditions, and hiding
 * system/junk files from user-facing lists.
 */

describe('detectContentKind', () => {
  it('detects a PDF from its icon', () => {
    expect(detectContentKind({ icon: 'application/pdf', isLink: false, fileMimes: [] })).toBe('pdf')
  })

  it('detects a PDF from a file field content-type when the icon is missing', () => {
    expect(detectContentKind({ icon: '', isLink: false, fileMimes: ['application/pdf'] }))
      .toBe('pdf')
  })

  it('prefers the web/link kind for a crawled link resource', () => {
    expect(detectContentKind({ icon: 'text/html', isLink: true, fileMimes: [] })).toBe('web')
  })

  it('maps media and image mimes', () => {
    expect(detectContentKind({ icon: 'video/mp4', isLink: false, fileMimes: [] })).toBe('video')
    expect(detectContentKind({ icon: 'audio/mpeg', isLink: false, fileMimes: [] })).toBe('audio')
    expect(detectContentKind({ icon: 'image/png', isLink: false, fileMimes: [] })).toBe('image')
  })

  it('classifies an Office document', () => {
    expect(
      detectContentKind({
        icon: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        isLink: false,
        fileMimes: [],
      }),
    ).toBe('office')
  })

  it('falls back to file when a non-office file is attached, else text', () => {
    expect(
      detectContentKind({ icon: 'application/zip', isLink: false, fileMimes: ['application/zip'] }),
    )
      .toBe('file')
    expect(detectContentKind({ icon: 'text/markdown', isLink: false, fileMimes: [] })).toBe('text')
  })
})

describe('isOfficeMime', () => {
  it('recognises OpenXML, legacy Office and OpenDocument', () => {
    expect(
      isOfficeMime('application/vnd.openxmlformats-officedocument.presentationml.presentation'),
    )
      .toBe(true)
    expect(isOfficeMime('application/msword')).toBe(true)
    expect(isOfficeMime('application/vnd.ms-powerpoint')).toBe(true)
    expect(isOfficeMime('application/vnd.oasis.opendocument.text')).toBe(true)
  })

  it('rejects non-office mimes', () => {
    expect(isOfficeMime('application/pdf')).toBe(false)
    expect(isOfficeMime(undefined)).toBe(false)
  })
})

describe('selectPreviewFile', () => {
  it('picks a PDF/image rendition distinct from the primary office file', () => {
    const files = [
      { fieldId: 'orig', contentType: 'application/vnd.ms-powerpoint' },
      { fieldId: 'preview', contentType: 'application/pdf' },
    ]
    expect(selectPreviewFile(files, 'orig')).toEqual({
      fieldId: 'preview',
      contentType: 'application/pdf',
    })
  })

  it('returns nothing when no rendition exists', () => {
    const files = [{ fieldId: 'orig', contentType: 'application/msword' }]
    expect(selectPreviewFile(files, 'orig')).toBeUndefined()
  })
})

describe('looksLikeSystemFileTitle', () => {
  it('flags dotfiles and log/temp artefacts', () => {
    expect(looksLikeSystemFileTitle('.uploaded.log')).toBe(true)
    expect(looksLikeSystemFileTitle('.DS_Store')).toBe(true)
    expect(looksLikeSystemFileTitle('ingest.log')).toBe(true)
  })

  it('keeps genuine titles', () => {
    expect(looksLikeSystemFileTitle('Managing Subsoil Acidity')).toBe(false)
  })
})

describe('isDisplayableResource excludes system files', () => {
  it('hides a .log artefact from user-facing lists', () => {
    expect(isDisplayableResource({ title: '.uploaded.log' })).toBe(false)
    expect(isDisplayableResource({ title: 'A genuine report' })).toBe(true)
  })
})
