import { Component, type ContextType, type ReactNode, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AccessProvider } from './components/AccessProvider.tsx'
import { PortalAccessGate, ResolvedAccess } from './components/PortalAccessGate.tsx'
import { RootRedirect } from './components/RootRedirect.tsx'
import { TenantLayout } from './pages/TenantLayout.tsx'
import { HomePage } from './pages/PortalHome.tsx'
import { SearchPage } from './pages/SearchPage.tsx'
import { AdminPage } from './pages/AdminPage.tsx'
import { PeoplePage } from './pages/PeoplePage.tsx'
import { AuditPage } from './pages/AuditPage.tsx'
import { ManagePage } from './pages/ManagePage.tsx'
import { LibraryPage } from './pages/LibraryPage.tsx'
import { ResourceDetailPage } from './pages/ResourceDetailPage.tsx'
import { AskPage } from './pages/AskPage.tsx'
import { InvestigationsPage } from './pages/InvestigationsPage.tsx'
import { InvestigationDetailPage } from './pages/InvestigationDetailPage.tsx'
import { AgenticPage } from './pages/AgenticPage.tsx'
import { AgentAskPage } from './pages/AgentAskPage.tsx'
import { GeneratePage } from './pages/GeneratePage.tsx'
import { AssessmentPage } from './pages/AssessmentPage.tsx'
import { GraphPage } from './pages/GraphPage.tsx'
import { DocsPage } from './pages/DocsPage.tsx'
import { HowItWorksPage } from './pages/HowItWorksPage.tsx'
import { AccessibilityPage } from './pages/AccessibilityPage.tsx'
import { ToolsPage } from './pages/ToolsPage.tsx'
import { TaxonomyPage } from './pages/TaxonomyPage.tsx'
import { EntityPage } from './pages/EntityPage.tsx'
import { NotFoundPage, RootNotFound } from './pages/NotFoundPage.tsx'
import { AppLocaleProvider, PortalLocaleContext } from './lib/portal-locale.tsx'
import { watchTextSpacing } from './lib/text-spacing.ts'

/** Last line of defence: a render error shows a recoverable message, never a blank page. */
class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  static override contextType = PortalLocaleContext
  declare context: ContextType<typeof PortalLocaleContext>
  override state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override render() {
    if (!this.state.failed) return this.props.children
    const { ui } = this.context
    return (
      <div className='flex min-h-screen items-center justify-center bg-app p-6'>
        <div className='rp-card max-w-md p-6 text-center'>
          <h1 className='font-display text-xl text-ink'>{ui('Something went wrong')}</h1>
          <p className='mt-2 text-sm text-ink-2'>
            {ui('The page hit an unexpected error. Reloading usually clears it.')}
          </p>
          <button
            type='button'
            className='rp-btn rp-btn-primary mt-4'
            onClick={() => location.reload()}
          >
            {ui('Reload')}
          </button>
        </div>
      </div>
    )
  }
}

const container = document.getElementById('root')
if (!container) {
  throw new Error('Root element #root not found')
}

// Clamped card text lets go while the reader's own text spacing applies (WCAG 1.4.12).
watchTextSpacing()

createRoot(container).render(
  <StrictMode>
    <AppLocaleProvider>
      <AppErrorBoundary>
        <BrowserRouter>
          <AccessProvider>
            <Routes>
              <Route
                path='/'
                element={
                  <ResolvedAccess>
                    <RootRedirect />
                  </ResolvedAccess>
                }
              />
              <Route
                path='/admin'
                element={
                  <ResolvedAccess>
                    <AdminPage />
                  </ResolvedAccess>
                }
              />
              <Route
                path='/admin/audit'
                element={
                  <ResolvedAccess>
                    <AuditPage />
                  </ResolvedAccess>
                }
              />
              <Route
                path='/admin/people'
                element={
                  <ResolvedAccess>
                    <PeoplePage />
                  </ResolvedAccess>
                }
              />
              <Route
                path='/t/:slug'
                element={
                  <PortalAccessGate>
                    <TenantLayout />
                  </PortalAccessGate>
                }
              >
                <Route index element={<HomePage />} />
                <Route path='search' element={<SearchPage />} />
                <Route path='library' element={<LibraryPage />} />
                <Route path='library/:id' element={<ResourceDetailPage />} />
                <Route path='ask/*' element={<AskPage />} />
                <Route path='investigations' element={<InvestigationsPage />} />
                <Route path='investigations/:id' element={<InvestigationDetailPage />} />
                <Route path='agentic' element={<AgenticPage />} />
                <Route path='agent' element={<AgentAskPage />} />
                <Route path='generate' element={<GeneratePage />} />
                <Route path='assessment' element={<AssessmentPage />} />
                <Route path='graph' element={<GraphPage />} />
                <Route path='tools' element={<ToolsPage />} />
                <Route path='help' element={<DocsPage />} />
                <Route path='help/:pageId' element={<DocsPage />} />
                <Route path='how-it-works' element={<HowItWorksPage />} />
                <Route path='accessibility' element={<AccessibilityPage />} />
                <Route path='entity/:name' element={<EntityPage />} />
                <Route path='taxonomy' element={<TaxonomyPage />} />
                <Route path='manage' element={<ManagePage />} />
                {/* Catch-all inside a portal: a friendly not-found with the chrome intact. */}
                <Route path='*' element={<NotFoundPage />} />
              </Route>
              {/* Catch-all outside any portal (bad top-level path). */}
              <Route path='*' element={<RootNotFound />} />
            </Routes>
          </AccessProvider>
        </BrowserRouter>
      </AppErrorBoundary>
    </AppLocaleProvider>
  </StrictMode>,
)
