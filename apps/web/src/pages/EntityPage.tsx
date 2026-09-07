import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useOutletContext, useParams } from 'react-router-dom'
import type { ScoredResource } from '@research-portal/core'
import { ApiError, type EntityDossier, getEntityDossier } from '../api/client.ts'
import { ResourceThumb } from '../components/ResourceThumb.tsx'
import { EmptyState, ErrorCard, Skeleton, TypeBadge } from '../components/ui.tsx'
import { passageIsQuotable } from '../lib/passage.ts'
import type { TenantOutletContext } from './TenantLayout.tsx'

type RelationEdge = EntityDossier['relations']['edges'][number]

/** Case-insensitive match - the platform's entity casing can drift between mentions. */
function sameEntity(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * One relation as a readable sentence chip: `source - label -> target`. The
 * current entity renders as plain highlighted text; the other side is a link
 * into its own dossier.
 */
function RelationChip({ edge, slug, name }: { edge: RelationEdge; slug: string; name: string }) {
  const renderSide = (value: string) => {
    if (sameEntity(value, name)) {
      return <span className='font-semibold text-ink'>{value}</span>
    }
    return (
      <Link
        to={`/t/${slug}/entity/${encodeURIComponent(value)}`}
        className='rp-focus inline-flex min-h-6 items-center rounded-[var(--rp-radius-btn)] font-medium underline decoration-dotted underline-offset-2 transition-colors duration-150 hover:text-[var(--rp-ink)]'
        style={{ color: 'var(--rp-accent-fg)' }}
      >
        {value}
      </Link>
    )
  }

  return (
    <div className='flex flex-wrap items-center gap-1.5 rounded-[var(--rp-radius)] border border-line bg-surface px-3.5 py-2.5 text-sm text-ink-2'>
      {renderSide(edge.source)}
      <span className='text-ink-3'>- {edge.label} &rarr;</span>
      {renderSide(edge.target)}
    </div>
  )
}

/** A resource card in the "Mentioned in" list - the SearchPage result-card idiom, trimmed. */
function MentionCard({ resource, slug }: { resource: ScoredResource; slug: string }) {
  return (
    <Link
      to={`/t/${slug}/library/${resource.id}`}
      className='rp-card rp-lift rp-focus flex gap-3.5 p-4'
    >
      <div
        className='relative aspect-[210/297] w-[4.5rem] shrink-0 self-start overflow-hidden border border-line'
        aria-hidden='true'
      >
        <ResourceThumb
          slug={slug}
          id={resource.id}
          type={resource.type}
          imgClassName='object-top'
        />
      </div>
      <div className='min-w-0 flex-1'>
        <TypeBadge type={resource.type} />
        <h3 className='rp-clamp-2 mt-2 text-sm font-semibold leading-snug text-ink'>
          {resource.title}
        </h3>
        {
          /* A name is matched by its byline, a contribution statement or a
           * declarations block as often as by a sentence about the person:
           * those are flagged by the search and never quoted (D3-04). */
        }
        {resource.matchedPassage && passageIsQuotable(resource)
          ? (
            <p className='rp-clamp-2 mt-1.5 text-sm italic leading-relaxed text-ink-2'>
              &ldquo;{resource.matchedPassage}&rdquo;
            </p>
          )
          : resource.summary
          ? (
            <p className='rp-clamp-2 mt-1.5 text-sm leading-relaxed text-ink-2'>
              {resource.summary}
            </p>
          )
          : null}
      </div>
    </Link>
  )
}

/** The relations list while the dossier loads: the name itself never waits (D3-17). */
function RelationsSkeleton() {
  return (
    <div className='space-y-2.5' aria-busy='true' aria-label='Loading connections'>
      <Skeleton className='h-11 w-full' />
      <Skeleton className='h-11 w-full' />
      <Skeleton className='h-11 w-3/4' />
    </div>
  )
}

export function EntityPage() {
  const { config } = useOutletContext<TenantOutletContext>()
  const params = useParams<{ name: string }>()
  // React Router has already decoded the path param - decoding again throws
  // on names that legitimately contain a percent sign.
  const name = params.name ?? ''

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['entity', config.slug, name],
    queryFn: () => getEntityDossier(config.slug, name),
    enabled: name.length > 0,
    // An unknown entity is an answer, not a failure worth retrying.
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  })
  const unknown = isError && error instanceof ApiError && error.status === 404

  const groups = useMemo(() => {
    if (!data) return []
    const found = data.relations.nodes.filter((node) => sameEntity(node.id, name))
    return [...new Set(found.map((node) => node.group))]
  }, [data, name])

  const relatedEdges = useMemo(() => {
    if (!data) return []
    return data.relations.edges
      .filter((edge) => sameEntity(edge.source, name) || sameEntity(edge.target, name))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [data, name])

  const askHref = `/t/${config.slug}/ask?ask=${
    encodeURIComponent(`What does the research say about ${name}?`)
  }`

  return (
    <main className='mx-auto max-w-4xl px-6 py-8'>
      <Link
        to={`/t/${config.slug}/graph`}
        className='rp-focus inline-flex min-h-6 items-center rounded-[var(--rp-radius-btn)] text-sm font-medium text-[var(--rp-ink-3)] transition-colors duration-150 hover:text-[var(--rp-ink)]'
      >
        &larr; Back to graph
      </Link>

      {isLoading
        ? (
          <>
            <div className='mt-4 flex flex-wrap items-start justify-between gap-4'>
              <div className='min-w-0'>
                <p className='rp-eyebrow text-ink-3'>Entity</p>
                <h1 className='rp-display mt-1.5 text-3xl text-ink sm:text-4xl'>{name}</h1>
              </div>
              <Link to={askHref} className='rp-btn rp-btn-primary shrink-0'>
                Ask about this
              </Link>
            </div>
            <section className='mt-8'>
              <h2 className='rp-eyebrow text-ink-3'>Connections</h2>
              <div className='mt-3'>
                <RelationsSkeleton />
              </div>
            </section>
          </>
        )
        : null}

      {unknown
        ? (
          <div className='mt-4'>
            <p className='rp-eyebrow text-ink-3'>Entity</p>
            <h1 className='rp-display mt-1.5 text-3xl text-ink sm:text-4xl'>{name}</h1>
            <div className='mt-6'>
              <EmptyState
                title='Nothing on this yet'
                description='No paper in the corpus mentions this name and the knowledge graph has no relations for it. Check the spelling, or search the library for a broader term.'
              >
                <Link
                  to={`/t/${config.slug}/search?q=${encodeURIComponent(name)}`}
                  className='rp-btn rp-btn-outline'
                >
                  Search the library
                </Link>
              </EmptyState>
            </div>
          </div>
        )
        : isError
        ? (
          <div className='mt-4'>
            <ErrorCard
              message={error instanceof Error ? error.message : 'Could not load this entity.'}
              onRetry={() => void refetch()}
            />
          </div>
        )
        : null}

      {!isLoading && !isError && data
        ? (
          <>
            <div className='mt-4 flex flex-wrap items-start justify-between gap-4'>
              <div className='min-w-0'>
                <p className='rp-eyebrow text-ink-3'>Entity</p>
                <h1 className='rp-display mt-1.5 text-3xl text-ink sm:text-4xl'>{data.name}</h1>
                {groups.length > 0
                  ? (
                    <div className='mt-2.5 flex flex-wrap gap-1.5'>
                      {groups.map((group) => (
                        <span
                          key={group}
                          className='rp-badge rp-badge-quiet uppercase tracking-[0.06em]'
                        >
                          {group}
                        </span>
                      ))}
                    </div>
                  )
                  : null}
              </div>
              <Link to={askHref} className='rp-btn rp-btn-primary shrink-0'>
                Ask about this
              </Link>
            </div>

            <section className='mt-8'>
              <h2 className='rp-eyebrow text-ink-3'>Connections</h2>
              {relatedEdges.length === 0
                ? (
                  <div className='mt-3'>
                    <EmptyState
                      title='No connections recorded yet'
                      description='The knowledge graph has no relations for this entity so far. The papers below still mention it.'
                    />
                  </div>
                )
                : (
                  <div className='mt-3 flex flex-col gap-2'>
                    {relatedEdges.map((edge, index) => (
                      <RelationChip
                        key={`${edge.source}-${edge.label}-${edge.target}-${index}`}
                        edge={edge}
                        slug={config.slug}
                        name={name}
                      />
                    ))}
                  </div>
                )}
            </section>

            <section className='mt-8'>
              <h2 className='rp-eyebrow text-ink-3'>Mentioned in</h2>
              {data.resources.length === 0
                ? (
                  <div className='mt-3'>
                    <EmptyState
                      title='No resources reference this entity yet'
                      description='It may only appear in the knowledge graph so far, without an indexed passage.'
                    />
                  </div>
                )
                : (
                  <div className='mt-3 space-y-3'>
                    {data.resources.map((resource) => (
                      <MentionCard key={resource.id} resource={resource} slug={config.slug} />
                    ))}
                  </div>
                )}
            </section>
          </>
        )
        : null}
    </main>
  )
}
