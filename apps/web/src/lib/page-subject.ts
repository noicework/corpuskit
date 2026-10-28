import { createContext, useContext, useEffect } from 'react'

/**
 * What a page is showing, for the browser tab: a document's title, or the library's search and
 * filters. The tenant layout owns `document.title` (see page-title.ts); a page hands it a subject
 * through this context, and the layout puts it in front of the surface name, so two documents or
 * two filtered library views open in tabs are told apart (WCAG 2.4.2).
 */
export const PageSubjectContext = createContext<(subject: string | null) => void>(() => {})

/** Name what this page shows in the tab title, for as long as the page is mounted. */
export function usePageSubject(subject: string | null | undefined): void {
  const setSubject = useContext(PageSubjectContext)
  const value = subject?.trim() || null
  useEffect(() => {
    setSubject(value)
    return () => setSubject(null)
  }, [setSubject, value])
}
