import { Component, type ReactNode, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { RootRedirect } from './components/RootRedirect.tsx'
import { TenantLayout } from './pages/TenantLayout.tsx'
import { ExplorePage } from './pages/ExplorePage.tsx'
import { SearchPage } from './pages/SearchPage.tsx'
import { AdminPage } from './pages/AdminPage.tsx'
import { ManagePage } from './pages/ManagePage.tsx'
import { LibraryPage } from './pages/LibraryPage.tsx'
import { ResourceDetailPage } from './pages/ResourceDetailPage.tsx'
import { AskPage } from './pages/AskPage.tsx'
import { InvestigationsPage } from './pages/InvestigationsPage.tsx'
import { InvestigationDetailPage } from './pages/InvestigationDetailPage.tsx'
import { AgenticPage } from './pages/AgenticPage.tsx'
import { GeneratePage } from './pages/GeneratePage.tsx'
import { AssessmentPage } from './pages/AssessmentPage.tsx'
import { GraphPage } from './pages/GraphPage.tsx'
import { DocsPage } from './pages/DocsPage.tsx'
import { ToolsPage } from './pages/ToolsPage.tsx'
import { TaxonomyPage } from './pages/TaxonomyPage.tsx'
import { EntityPage } from './pages/EntityPage.tsx'
import { NotFoundPage, RootNotFound } from './pages/NotFoundPage.tsx'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

/** Last line of defence: a render error shows a recoverable message, never a blank page. */
class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className='flex min-h-screen items-center justify-center bg-app p-6'>
        <div className='rp-card max-w-md p-6 text-center'>
          <h1 className='font-display text-xl text-ink'>Something went wrong</h1>
          <p className='mt-2 text-sm text-ink-2'>
            The page hit an unexpected error. Reloading usually clears it.
          </p>
          <button
            type='button'
            className='rp-btn rp-btn-primary mt-4'
            onClick={() => location.reload()}
          >
            Reload
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

createRoot(container).render(
  <StrictMode>
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Routes>
            <Route path='/' element={<RootRedirect />} />
            <Route path='/admin' element={<AdminPage />} />
            <Route path='/t/:slug' element={<TenantLayout />}>
              <Route index element={<ExplorePage />} />
              <Route path='search' element={<SearchPage />} />
              <Route path='library' element={<LibraryPage />} />
              <Route path='library/:id' element={<ResourceDetailPage />} />
              <Route path='ask/*' element={<AskPage />} />
              <Route path='investigations' element={<InvestigationsPage />} />
              <Route path='investigations/:id' element={<InvestigationDetailPage />} />
              <Route path='agentic' element={<AgenticPage />} />
              <Route path='generate' element={<GeneratePage />} />
              <Route path='assessment' element={<AssessmentPage />} />
              <Route path='graph' element={<GraphPage />} />
              <Route path='tools' element={<ToolsPage />} />
              <Route path='help' element={<DocsPage />} />
              <Route path='help/:pageId' element={<DocsPage />} />
              <Route path='entity/:name' element={<EntityPage />} />
              <Route path='taxonomy' element={<TaxonomyPage />} />
              <Route path='manage' element={<ManagePage />} />
              {/* Catch-all inside a portal: a friendly not-found with the chrome intact. */}
              <Route path='*' element={<NotFoundPage />} />
            </Route>
            {/* Catch-all outside any portal (bad top-level path). */}
            <Route path='*' element={<RootNotFound />} />
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </AppErrorBoundary>
  </StrictMode>,
)
