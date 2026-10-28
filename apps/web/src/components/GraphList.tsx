import { Link } from 'react-router-dom'
import { usePortalLocale } from '../lib/portal-locale.tsx'
import { graphGroupLabel, graphRelationLabel } from '../lib/graph-display-copy.ts'
import type { MapEdge, MapNode } from './KnowledgeMap.tsx'

/** Both lenses expose exactly the nodes and directed edges supplied to the map. */
export function GraphList({ nodes, edges, slug, concept }: {
  nodes: MapNode[]
  edges: MapEdge[]
  slug: string
  concept: boolean
}) {
  const { ui } = usePortalLocale()
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const categories = new Map<string, number>()
  for (const node of nodes) categories.set(node.group, (categories.get(node.group) ?? 0) + 1)
  const linked = new Map<string, MapEdge[]>()
  for (const edge of edges) {
    for (const id of new Set([edge.source, edge.target])) {
      const list = linked.get(id) ?? []
      list.push(edge)
      linked.set(id, list)
    }
  }
  const href = (node: MapNode) => {
    const params = new URLSearchParams(
      concept
        ? {
          [node.id.startsWith('topic:') ? 'topic' : 'kind']: node.id.slice(
            node.id.indexOf(':') + 1,
          ),
        }
        : { q: node.label },
    )
    return `/t/${slug}/library?${params}`
  }
  return (
    <section className='rp-shell py-5' aria-label={ui('Graph list')} data-graph-list>
      <h2 className='rp-display text-xl text-ink'>{ui('Topics and relationships')}</h2>
      <p className='mt-2 text-sm text-ink-2'>
        {ui(
          'The same graph as a list. Each item names its category, counts and relationships. Open an item to find its resources in the library.',
        )}
      </p>
      <ul
        aria-label={ui('Category totals')}
        className='mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm text-ink-2'
      >
        {[...categories].map(([group, count]) => (
          <li key={group} className='min-w-0 [overflow-wrap:anywhere]'>
            <span className='font-semibold'>{graphGroupLabel(group, ui)}</span>
            {': '}
            {count}
          </li>
        ))}
      </ul>
      <ul data-graph-items className='mt-4 grid items-start gap-4 lg:grid-cols-2 2xl:grid-cols-3'>
        {nodes.map((node) => {
          const relations = linked.get(node.id) ?? []
          return (
            <li key={node.id} className='rp-card min-w-0 p-4 [overflow-wrap:anywhere]'>
              <h3 className='text-base font-semibold text-ink break-words'>
                <Link
                  className='rp-focus rp-link-standalone max-w-full underline [overflow-wrap:anywhere]'
                  to={href(node)}
                >
                  {node.label}
                </Link>
              </h3>
              <dl className='my-3 text-sm text-ink-2'>
                <div>
                  <dt className='inline font-semibold'>{ui('Category')}:</dt>{' '}
                  <dd className='inline'>{graphGroupLabel(node.group, ui)}</dd>
                </div>
                <div>
                  <dt className='inline font-semibold'>
                    {ui(concept ? 'Resources' : 'Mentions')}:
                  </dt>{' '}
                  <dd className='inline'>{node.weight}</dd>
                </div>
                <div>
                  <dt className='inline font-semibold'>{ui('Relationships')}:</dt>{' '}
                  <dd className='inline'>{relations.length}</dd>
                </div>
              </dl>
              {relations.length > 0
                ? (
                  <ul className='space-y-2 text-sm text-ink-2'>
                    {relations.map((edge, index) => {
                      const source = byId.get(edge.source)
                      const target = byId.get(edge.target)
                      return (
                        <li key={index} className='break-words'>
                          {source?.label ?? edge.source}
                          {' · '}
                          {concept ? edge.label : graphRelationLabel(edge.label, ui)}
                          {' · '}
                          {target?.label ?? edge.target}
                        </li>
                      )
                    })}
                  </ul>
                )
                : <p className='text-sm text-ink-2'>{ui('No relationships recorded.')}</p>}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
