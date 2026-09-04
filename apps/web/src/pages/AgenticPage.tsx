import { Navigate, useOutletContext } from 'react-router-dom'
import type { TenantOutletContext } from './TenantLayout.tsx'

// ---------------------------------------------------------------------------
// Agentic retrieval used to be its own surface with its own answer rendering,
// its own evidence table, and its own pipeline visualisation - a second,
// subtly different way to ask the same corpus the same question. That's now
// one surface (Ask): the pipeline view lives there as a collapsible
// "Show the pipeline" disclosure under each answer instead. This route stays
// so old links/bookmarks keep working, and just forwards to Ask.
// ---------------------------------------------------------------------------

export function AgenticPage() {
  const { config } = useOutletContext<TenantOutletContext>()
  return <Navigate to={`/t/${config.slug}/ask`} replace />
}
