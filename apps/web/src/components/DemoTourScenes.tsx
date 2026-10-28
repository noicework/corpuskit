import { usePortalLocale } from '../lib/portal-locale.tsx'
import { useEffect, useState } from 'react'
import type { Citation, DemoTourSceneId, ScoredResource } from '@research-portal/core'
import { AnswerText } from './AnswerInline.tsx'
import { EvidenceDisclosure } from './AnswerStream.tsx'
import { STAGE_STEPS, type StageStatuses, StageTimeline, statusesFor } from './StageTimeline.tsx'
import { Button, TypeBadge } from './ui.tsx'
import { mcpConfigSnippet } from '../pages/ToolsPage.tsx'
import { Check, Compass, Search } from './icons.tsx'
import type { ResolvedScene } from '../lib/demo-tour.ts'

/**
 * The tour's illustrations: each scene drawn with the portal's own components over fixture
 * data, so a scene looks like the feature it stands for, on every palette, shape and density,
 * and drifts from the product only when the product's components change. The data is made up
 * and generic; nothing here comes from, or names, a real collection.
 *
 * Every illustration is decorative to assistive technology: the dialog hides the whole pane
 * from the accessibility tree and makes it inert, and the scene's words beside it carry the
 * meaning. Motion is a staged reveal and a typed question, both still under reduced motion.
 */

const COLLECTIONS = { studies: 'Playground studies', guidance: 'Design guidance' } as const

const SOURCES: ScoredResource[] = [
  {
    id: 'tour-shade-2021',
    title: 'Shade cover and surface temperature in school playgrounds',
    summary: 'Surface temperatures under tree canopy, shade sails and open sky across one summer.',
    type: 'pdf',
    topicIds: [],
    keyFacts: [],
    year: '2021',
    authors: ['R. Okafor', 'L. Marsh'],
    relevance: 0.91,
    citedCount: 1,
    matchedPage: 4,
    matchedPassage:
      'On each afternoon measured, the rubber surface under tree canopy was 10 to 15°C cooler than in open sun.',
  },
  {
    id: 'tour-cool-play-2019',
    title: 'Designing cool play spaces: a guide for councils',
    summary: 'Planting, shade structures and surface choices that keep play spaces usable in heat.',
    type: 'document',
    topicIds: [],
    keyFacts: [],
    year: '2019',
    relevance: 0.78,
    citedCount: 1,
  },
]

const CITATIONS: Citation[] = [
  { index: 1, resourceId: 'tour-shade-2021', title: SOURCES[0]!.title },
  { index: 2, resourceId: 'tour-cool-play-2019', title: SOURCES[1]!.title },
]

const QUESTION = 'Does shade cover keep playground surfaces cooler?'
const ANSWER =
  'On the afternoons measured in one study, rubber surfaces under tree canopy were 10 to 15°C cooler than surfaces in open sun [1]. A design guide for councils recommends trees for long-term shade, with shade sails while the trees grow [2].'
const CITED_LINE =
  'On the afternoons measured in one study, rubber surfaces under tree canopy were 10 to 15°C cooler than surfaces in open sun [1].'
const GAP_QUESTION = 'How do playground surfaces hold up in snow?'

function prefersReducedMotion(): boolean {
  try {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  } catch {
    return false
  }
}

/** The text so far of a question being typed; the whole text at once under reduced motion. */
function useTyped(text: string): string {
  const [shown, setShown] = useState(0)
  useEffect(() => {
    if (prefersReducedMotion()) {
      setShown(text.length)
      return
    }
    setShown(0)
    let count = 0
    const timer = setInterval(() => {
      count += 1
      setShown(count)
      if (count >= text.length) clearInterval(timer)
    }, 28)
    return () => clearInterval(timer)
  }, [text])
  return text.slice(0, shown)
}

/** Whether the typed question has finished, so the answer can follow it. */
function useAfter(ms: number): boolean {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (prefersReducedMotion()) {
      setReady(true)
      return
    }
    setReady(false)
    const timer = setTimeout(() => setReady(true), ms)
    return () => clearTimeout(timer)
  }, [ms])
  return ready
}

/** The pipeline's stages passing one by one, as the real timeline shows them. */
function useStagePlayback(): { statuses: StageStatuses; done: boolean } {
  const [index, setIndex] = useState(0)
  useEffect(() => {
    if (prefersReducedMotion()) {
      setIndex(STAGE_STEPS.length)
      return
    }
    setIndex(0)
    const timer = setInterval(() => {
      setIndex((current) => {
        if (current + 1 >= STAGE_STEPS.length) clearInterval(timer)
        return Math.min(current + 1, STAGE_STEPS.length)
      })
    }, 650)
    return () => clearInterval(timer)
  }, [])
  const done = index >= STAGE_STEPS.length
  const active = done ? null : STAGE_STEPS[index]!.key
  const seen = new Set(STAGE_STEPS.slice(0, index).map((step) => step.key))
  return { statuses: statusesFor(active, seen), done }
}

function Reveal({ delay = 0, children }: { delay?: number; children: React.ReactNode }) {
  return <div className='rp-tour-reveal' style={{ animationDelay: `${delay}ms` }}>{children}</div>
}

/** The ask field as the hero draws it, with the question typing itself in. */
function AskField({ question }: { question: string }) {
  const { ui } = usePortalLocale()
  const typed = useTyped(question)
  return (
    <div className='rp-field flex items-center gap-2 rounded-[var(--rp-radius-input)] border bg-surface p-1.5 pl-3.5'>
      <Search className='shrink-0 text-ink-3' />
      <span className='min-h-[calc(2.75rem*var(--rp-density-ctl,1))] min-w-0 flex-1 break-words px-2 py-2 text-base text-ink'>
        {typed}
        {typed.length < question.length ? <span className='rp-tour-caret' /> : null}
      </span>
      <Button type='button' size='lg' className='shrink-0 self-stretch font-semibold' tabIndex={-1}>
        {ui('Ask')}
      </Button>
    </div>
  )
}

function AnswerCard({ slug, text }: { slug: string; text: string }) {
  const { ui } = usePortalLocale()
  return (
    <div className='rp-card p-4'>
      <AnswerText
        text={text}
        citations={CITATIONS}
        sources={SOURCES}
        slug={slug}
        streaming={false}
        bodyClassName='rp-prose text-sm text-ink-2'
      />
      <p className='mt-3 border-t border-line pt-3'>
        <span className='rp-badge rp-badge-quiet'>{ui('Moderate confidence')}</span>
      </p>
    </div>
  )
}

function SourceRow({ source, page }: { source: ScoredResource; page?: number }) {
  const { ui } = usePortalLocale()
  return (
    <li className='flex min-w-0 items-center gap-2 text-sm'>
      <span className='shrink-0'>
        <TypeBadge type={source.type} />
      </span>
      <span className='min-w-0 truncate text-ink'>{source.title}</span>
      {page
        ? <span className='shrink-0 text-xs text-ink-3'>{ui('p. {page}', { page })}</span>
        : null}
    </li>
  )
}

function FederatedScene({ slug }: { slug: string }) {
  const { ui } = usePortalLocale()
  const answered = useAfter(QUESTION.length * 28 + 400)
  return (
    <div className='space-y-4'>
      <AskField question={QUESTION} />
      {answered
        ? (
          <>
            <Reveal>
              <AnswerCard slug={slug} text={ANSWER} />
            </Reveal>
            <Reveal delay={220}>
              <div className='rp-card min-w-0 p-3'>
                <p className='rp-eyebrow text-ink-3'>{ui('retrieved sources')}</p>
                <ul className='mt-2 min-w-0 space-y-1.5'>
                  {SOURCES.map((source) => (
                    <SourceRow key={source.id} source={source} page={source.matchedPage} />
                  ))}
                </ul>
              </div>
            </Reveal>
          </>
        )
        : null}
    </div>
  )
}

function ProvenanceScene() {
  const { ui } = usePortalLocale()
  const { statuses, done } = useStagePlayback()
  return (
    <div className='space-y-4'>
      <div className='rp-card p-4'>
        <StageTimeline statuses={statuses} reading={[SOURCES[0]!.title]} />
      </div>
      {done
        ? (
          <Reveal>
            <div className='rp-card p-4'>
              <EvidenceDisclosure
                regionId='demo-tour-evidence'
                open={false}
                onToggle={() => {}}
                label={ui('retrieved sources')}
                summary={ui('{count} sources · {cited} cited', { count: 2, cited: 2 })}
              >
                {null}
              </EvidenceDisclosure>
              <div className='mt-3 border-t border-line pt-3'>
                <span className='rp-btn rp-btn-ghost rp-btn-sm'>
                  <Compass size='sm' />
                  {ui('Journey through the context')}
                </span>
              </div>
            </div>
          </Reveal>
        )
        : null}
    </div>
  )
}

function CitedPageScene({ slug }: { slug: string }) {
  const { ui } = usePortalLocale()
  const opened = useAfter(1100)
  const source = SOURCES[0]!
  return (
    <div className='space-y-4'>
      <div className='rp-card p-4'>
        <span className={opened ? '' : 'rp-tour-glow rounded-[var(--rp-radius-chip)]'}>
          <AnswerText
            text={CITED_LINE}
            citations={CITATIONS}
            sources={SOURCES}
            slug={slug}
            streaming={false}
            bodyClassName='rp-prose text-sm text-ink-2'
          />
        </span>
      </div>
      {opened
        ? (
          <Reveal>
            <div className='grid gap-3 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]'>
              <div className='rp-tour-page p-4' aria-hidden='true'>
                <p className='rp-eyebrow text-ink-3'>
                  {ui('Page {page}', { page: source.matchedPage ?? 1 })}
                </p>
                <div className='mt-3 space-y-2'>
                  <div className='rp-tour-line w-11/12' />
                  <div className='rp-tour-line w-full' />
                  <div className='rp-tour-line w-4/5' />
                  <div className='rp-tour-passage mt-3 space-y-2 py-2 pl-2'>
                    <div className='rp-tour-line w-full' />
                    <div className='rp-tour-line w-10/12' />
                  </div>
                  <div className='rp-tour-line w-full' />
                  <div className='rp-tour-line w-3/5' />
                </div>
              </div>
              <div className='rp-card min-w-0 p-4'>
                <p className='rp-eyebrow text-ink-3'>{ui('Matched passage')}</p>
                <blockquote
                  className='mt-2 break-words text-sm leading-relaxed text-ink-2'
                  style={{ borderColor: 'var(--rp-accent)' }}
                >
                  &ldquo;{source.matchedPassage}&rdquo;
                </blockquote>
                <p className='mt-2 text-xs font-medium tabular-nums text-ink-3'>
                  {ui('From page {page}', { page: source.matchedPage ?? 1 })}
                </p>
              </div>
            </div>
          </Reveal>
        )
        : null}
    </div>
  )
}

/** A few nodes and the links between them, drawn in the portal's own marks. */
function GraphScene({ kinds }: { kinds: string[] }) {
  const labels = (kinds.length > 0 ? kinds : ['Topic', 'Organisation', 'Region', 'Author'])
    .slice(0, 4)
  const nodes = [
    { x: 150, y: 70, r: 26 },
    { x: 60, y: 160, r: 20 },
    { x: 250, y: 150, r: 22 },
    { x: 160, y: 230, r: 18 },
  ]
  const edges: [number, number][] = [[0, 1], [0, 2], [0, 3], [1, 3], [2, 3]]
  return (
    <div className='rp-card p-4'>
      <svg
        viewBox='0 0 320 280'
        className='mx-auto block h-auto w-full max-w-[22rem]'
        aria-hidden='true'
      >
        {edges.map(([a, b], index) => (
          <g key={index} className='rp-tour-reveal' style={{ animationDelay: `${index * 90}ms` }}>
            <line
              x1={nodes[a]!.x}
              y1={nodes[a]!.y}
              x2={nodes[b]!.x}
              y2={nodes[b]!.y}
              stroke='var(--rp-line-2)'
              strokeWidth={2}
            />
          </g>
        ))}
        {nodes.map((node, index) => (
          <g key={index} className='rp-tour-reveal' style={{ animationDelay: `${index * 120}ms` }}>
            <circle
              cx={node.x}
              cy={node.y}
              r={node.r}
              fill='var(--rp-wash)'
              stroke={index === 0 ? 'var(--rp-accent-line)' : 'var(--rp-brand-fg)'}
              strokeWidth={index === 0 ? 3 : 2}
            />
            <text
              x={node.x}
              y={node.y + node.r + 16}
              textAnchor='middle'
              fontSize='13'
              fill='var(--rp-ink-2)'
            >
              {labels[index] ?? ''}
            </text>
          </g>
        ))}
      </svg>
    </div>
  )
}

function McpScene({ slug }: { slug: string }) {
  const { ui } = usePortalLocale()
  const origin = globalThis.location?.origin ?? 'https://portal.example.org'
  const lines = mcpConfigSnippet(`${origin}/api/t/${encodeURIComponent(slug)}/mcp`, slug)
    .split('\n')
  return (
    <div className='rp-card p-4'>
      <h3 className='rp-display text-base text-ink'>{ui('MCP connector')}</h3>
      <pre className='mt-3 max-w-full whitespace-pre-wrap break-words rounded-[var(--rp-radius-input)] border border-line bg-[var(--rp-surface-2)] p-3 text-xs leading-relaxed [overflow-wrap:anywhere]'>
        <code>
          {lines.map((line, index) => (
            <Reveal key={index} delay={index * 90}>{line}</Reveal>
          ))}
        </code>
      </pre>
      <div className='mt-3 flex flex-wrap gap-2'>
        <span className='rp-badge rp-badge-quiet'>{ui('Read-only')}</span>
      </div>
    </div>
  )
}

function ParticipationScene() {
  const { ui } = usePortalLocale()
  const rows = [
    { name: COLLECTIONS.studies, takesPart: true },
    { name: COLLECTIONS.guidance, takesPart: true },
    { name: 'Archive, 1998 to 2004', takesPart: false },
  ]
  return (
    <div className='rp-card p-4'>
      <p className='rp-eyebrow text-ink-3'>{ui('Collections for this answer')}</p>
      <ul className='mt-3 divide-y divide-[var(--rp-line)]'>
        {rows.map((row, index) => (
          <li key={row.name} className='py-2'>
            <Reveal delay={index * 140}>
              <div className='flex items-center justify-between gap-3 text-sm'>
                <span className='min-w-0 truncate text-ink'>{ui(row.name)}</span>
                <span
                  className={`rp-badge shrink-0 ${
                    row.takesPart ? 'rp-badge-ok' : 'rp-badge-quiet'
                  }`}
                >
                  {row.takesPart ? ui('Used') : ui('Not reached')}
                </span>
              </div>
            </Reveal>
          </li>
        ))}
      </ul>
    </div>
  )
}

function GapsScene() {
  const { ui } = usePortalLocale()
  const question = GAP_QUESTION
  const answered = useAfter(question.length * 28 + 400)
  return (
    <div className='space-y-4'>
      <AskField question={question} />
      {answered
        ? (
          <Reveal>
            <div className='rp-card p-4'>
              <span className='rp-badge rp-badge-quiet'>{ui('No direct evidence found')}</span>
              <p className='rp-prose mt-3 text-sm text-ink-2'>
                {ui('The collection has no direct evidence about playground surfaces in snow.')}
              </p>
              <p className='rp-eyebrow mt-4 border-t border-line pt-3 text-ink-3'>
                {ui('closest matches, not used')}
              </p>
              <ul className='mt-2 space-y-1.5'>
                {SOURCES.map((source) => <SourceRow key={source.id} source={source} />)}
              </ul>
            </div>
          </Reveal>
        )
        : null}
    </div>
  )
}

/** The scene list, for the welcome and the finish: what the tour shows, and what it showed. */
export function SceneList({ scenes, done }: { scenes: ResolvedScene[]; done: boolean }) {
  return (
    <ol className='space-y-2'>
      {scenes.map((scene, index) => (
        <li key={scene.id}>
          <Reveal delay={index * 90}>
            <div className='flex items-center gap-3 rounded-[var(--rp-radius)] border border-line bg-surface px-3 py-2 text-sm'>
              <span className='flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--rp-wash)] text-xs font-semibold tabular-nums text-[var(--rp-brand-fg)]'>
                {done ? <Check size='sm' /> : index + 1}
              </span>
              <span className='min-w-0 break-words text-ink'>{scene.title}</span>
            </div>
          </Reveal>
        </li>
      ))}
    </ol>
  )
}

export function SceneIllustration(
  { id, slug, kinds }: { id: DemoTourSceneId; slug: string; kinds: string[] },
) {
  switch (id) {
    case 'federated':
      return <FederatedScene slug={slug} />
    case 'provenance':
      return <ProvenanceScene />
    case 'cited-page':
      return <CitedPageScene slug={slug} />
    case 'graph':
      return <GraphScene kinds={kinds} />
    case 'mcp':
      return <McpScene slug={slug} />
    case 'participation':
      return <ParticipationScene />
    case 'gaps':
      return <GapsScene />
  }
}
