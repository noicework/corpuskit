import { useEffect, useRef } from 'react'
import { useAccess } from './AccessProvider.tsx'
import { Download } from './icons.tsx'
import { ExportNotice, savedFileNotice, useExportNotice } from './ui.tsx'
import {
  type AgentAnswerRecord,
  agentTrailTitle,
  agentTrailToWordHtml,
  hasExportableTurn,
} from '../lib/agent-answer-export.ts'
import { usePortalLocale } from '../lib/portal-locale.tsx'
import { exportResearchFile, researchExportAuthority } from '../lib/research-export.ts'
import { slugOrDate } from '../lib/word-document.ts'

/**
 * The evidence brief control for an agent ask page: saves the trail of agent
 * ask turns as a Word document with references grouped by collection. It
 * mirrors the Ask page's "Export" (same look, same permission, same saved-file
 * notice) so the two pages behave alike. Renders nothing for a reader who may
 * not export; disabled while an answer is still streaming or no turn has
 * finished.
 */
export function AgentAnswerExportButton(
  { slug, portalName, turns, busy = false, title, className = '' }: {
    slug: string
    /** The name on the document's first line (the portal's product name). */
    portalName: string
    /** The turns to save, oldest first. */
    turns: readonly AgentAnswerRecord[]
    /** An answer is still streaming: the export waits for it. */
    busy?: boolean
    /** The document's title and file name; the first question when omitted. */
    title?: string
    className?: string
  },
) {
  const { ui, language } = usePortalLocale()
  const access = useAccess()
  const { notice, announce } = useExportNotice()
  const lifetime = useRef(new AbortController())
  useEffect(() => {
    if (lifetime.current.signal.aborted) lifetime.current = new AbortController()
    return () => lifetime.current.abort()
  }, [])
  const canExport = access.can('portal.export', { kind: 'portal', slug })
  if (!canExport) return null
  const ready = !busy && hasExportableTurn(turns)

  async function exportTrail() {
    if (!ready) return
    const authority = {
      ...researchExportAuthority(access.controller, slug),
      signal: lifetime.current.signal,
    }
    const heading = title?.trim() || agentTrailTitle(turns) || ui('Evidence brief')
    try {
      const filename = await exportResearchFile(authority, () => ({
        parts: [
          '﻿',
          agentTrailToWordHtml(
            portalName,
            heading,
            turns,
            (portal, resourceId) =>
              `${globalThis.location.origin}/t/${encodeURIComponent(portal)}/library/${
                encodeURIComponent(resourceId)
              }`,
            ui,
            language,
          ),
        ],
        type: 'application/msword',
        filename: `${slugOrDate(heading)}.doc`,
      }))
      authority.signal.throwIfAborted()
      access.controller.assertCurrent(authority.context)
      announce(savedFileNotice(filename, ui('Word document'), ui))
    } catch {
      // An obsolete or incomplete export has no file and no success notice.
    }
  }

  return (
    <span className={`inline-flex flex-wrap items-center gap-2 ${className}`}>
      <button
        type='button'
        onClick={() => void exportTrail()}
        disabled={!ready}
        title={busy
          ? ui('Export is available once the answer has finished')
          : ui('Save this answer trail as a Word document with references grouped by collection')}
        className='rp-btn rp-btn-ghost rp-btn-sm shrink-0 disabled:cursor-not-allowed'
      >
        <Download size='sm' />
        {ui('Export')}
      </button>
      <ExportNotice notice={notice} />
    </span>
  )
}
