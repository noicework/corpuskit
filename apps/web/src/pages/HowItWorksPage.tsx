import { usePortalLocale } from '../lib/portal-locale.tsx'
import { HELP_PAGES_JA } from '../lib/help-pages-ja.ts'
import { HelpMarkdown } from './DocsPage.tsx'
import type { ReactNode } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import type { KbCounters } from '@research-portal/core'
import { getCounters } from '../api/client.ts'
import { Skeleton } from '../components/ui.tsx'
import { ArrowRight } from '../components/icons.tsx'
import type { TenantOutletContext } from './TenantLayout.tsx'

// ---------------------------------------------------------------------------
// How this works: the architecture of the portal in the words a
// clinician-researcher would use. The prose here is kept in step with the
// `how-this-works` documentation page in packages/core/src/docs.ts (the help
// assistant answers from that copy); a unit test holds the two to the same
// section headings. Figures on the page come from the live counters endpoint,
// never from the copy.
// ---------------------------------------------------------------------------

/** The sections, in order, with their anchor ids. Shared with the unit test. */
export const HOW_IT_WORKS_SECTIONS = [
  { id: 'content', heading: 'Where the content comes from' },
  { id: 'ingest', heading: 'What happens when a document is added' },
  { id: 'answered', heading: 'How a question is answered' },
  { id: 'checked', heading: 'How the answer is checked before you see it' },
  { id: 'tools', heading: 'What you can do with it' },
  { id: 'limits', heading: 'What it deliberately does not do' },
  { id: 'under-the-hood', heading: 'Under the hood' },
] as const

type SectionId = (typeof HOW_IT_WORKS_SECTIONS)[number]['id']

function headingFor(id: SectionId): string {
  return HOW_IT_WORKS_SECTIONS.find((section) => section.id === id)?.heading ?? ''
}

// ---------------------------------------------------------------------------
// The flow diagram uses normal document text so each step grows with the
// reader's text size. It is a row from `lg` and a stacked column below it.
// Every ground and edge follows the palette and shape dials.
// ---------------------------------------------------------------------------

type FlowStep = { title: string; detail: string }

export const FLOW_STEPS: FlowStep[] = [
  { title: 'The collection', detail: 'Papers, supplementary files and video material' },
  {
    title: 'The index',
    detail: 'Text and tables extracted; summary, labels and relations written',
  },
  { title: 'Your question', detail: 'Routed by intent to the retrieval configuration it suits' },
  { title: 'The passages', detail: 'The index returns the passages that match the question' },
  { title: 'The answer', detail: 'Written from those passages only; every sentence cited' },
  {
    title: 'The check',
    detail: 'Figures, cohorts and named studies verified; confidence labelled',
  },
]

/** Greedy word wrap to at most `max` characters per line. */
export function wrapWords(text: string, max: number): string[] {
  // Japanese has no space-delimited words. Two Latin-width units per full-width glyph
  // keeps the SVG labels within the same measured line budget as English.
  if (/[\u2e80-\u9fff\uf900-\ufaff\uff01-\uff60]/u.test(text)) {
    const lines: string[] = []
    let line = '', width = 0
    for (const char of text.normalize('NFC')) {
      const size = /[\u2e80-\u9fff\uf900-\ufaff\uff01-\uff60]/u.test(char) ? 2 : 1
      if (line && width + size > max) {
        lines.push(line.trim())
        line = ''
        width = 0
      }
      line += char
      width += size
    }
    if (line.trim()) lines.push(line.trim())
    return lines
  }
  const lines: string[] = []
  let current = ''
  for (const word of text.split(/\s+/)) {
    const next = current ? `${current} ${word}` : word
    if (next.length > max && current) {
      lines.push(current)
      current = word
    } else {
      current = next
    }
  }
  if (current) lines.push(current)
  return lines
}

function FlowSteps({ orientation }: { orientation: 'row' | 'column' }) {
  const { ui, number } = usePortalLocale()
  const row = orientation === 'row'
  return (
    <ol
      className={row ? 'hidden grid-cols-6 gap-8 lg:grid' : 'space-y-8 lg:hidden'}
      data-orientation={orientation}
      aria-hidden='true'
    >
      {FLOW_STEPS.map((step, index) => (
        <li key={step.title} className='relative flex min-w-0'>
          <div
            className='flex w-full min-w-0 flex-col gap-2 rounded-[max(0px,calc(var(--rp-radius)-0.25rem))] border p-4'
            style={{
              backgroundColor: index === FLOW_STEPS.length - 1
                ? 'var(--rp-wash)'
                : 'var(--rp-surface-2)',
              borderColor: 'var(--rp-line)',
            }}
          >
            <span
              className='inline-flex min-h-6 min-w-6 self-start items-center justify-center rounded-full px-1 text-xs font-semibold'
              style={{ backgroundColor: 'var(--rp-accent)', color: 'var(--rp-on-accent)' }}
            >
              {number(index + 1)}
            </span>
            <p className='text-sm font-semibold' style={{ color: 'var(--rp-ink)' }}>
              {ui(step.title)}
            </p>
            <p className='text-sm leading-relaxed text-ink-2'>{ui(step.detail)}</p>
          </div>
          {index < FLOW_STEPS.length - 1 && (
            <span
              className={row
                ? 'absolute top-1/2 -right-4 translate-x-1/2 -translate-y-1/2 text-ink-3'
                : 'absolute -bottom-4 left-1/2 -translate-x-1/2 translate-y-1/2 text-ink-3'}
            >
              <ArrowRight size='md' className={row ? '' : 'rotate-90'} />
            </span>
          )}
        </li>
      ))}
    </ol>
  )
}

export function FlowDiagram() {
  const { ui } = usePortalLocale()
  const description = FLOW_STEPS.map((step, index) =>
    `${index + 1}. ${ui(step.title)}: ${ui(step.detail)}.`
  ).join(' ')
  return (
    <figure
      className='rp-card p-5 lg:p-6'
      data-testid='how-it-works-flow'
      role='img'
      aria-label={ui('The flow of one question through the portal. {description}', { description })}
    >
      <FlowSteps orientation='row' />
      <FlowSteps orientation='column' />
      <figcaption className='mt-4 text-xs text-ink-3'>
        {ui('The flow of one question, from the collection to the checked answer.')}
      </figcaption>
    </figure>
  )
}

// ---------------------------------------------------------------------------
// Live figures, straight from the knowledge index. Nothing here is typed into
// the copy: when the counters cannot be read the strip is not shown and the
// prose falls back to wording that carries no number.
// ---------------------------------------------------------------------------

function Figure({ label, value }: { label: string; value: number | null }) {
  const { ui, number } = usePortalLocale()
  return (
    <div className='rp-card flex items-baseline justify-between gap-3 p-5 sm:block lg:p-6'>
      <dt className='rp-eyebrow text-ink-3'>{ui(label)}</dt>
      {value === null
        ? <Skeleton className='h-6 w-16 sm:mt-1.5' />
        : (
          <dd className='rp-display text-2xl tabular-nums text-ink sm:mt-1'>
            {number(value)}
          </dd>
        )}
    </div>
  )
}

function LiveFigures({ counters, pending }: { counters?: KbCounters; pending: boolean }) {
  const { ui } = usePortalLocale()
  if (!counters && !pending) return null
  return (
    <section aria-label={ui('The collection today')} data-testid='how-it-works-figures'>
      <dl className='grid grid-cols-1 gap-2 sm:grid-cols-3 sm:gap-3'>
        <Figure label='Resources' value={counters?.resources ?? null} />
        <Figure label='Paragraphs' value={counters?.paragraphs ?? null} />
        <Figure label='Sentences' value={counters?.sentences ?? null} />
      </dl>
      <p className='mt-2 text-xs text-ink-3'>{ui('Live from the knowledge index.')}</p>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Prose helpers.
// ---------------------------------------------------------------------------

function Bullet({ children }: { children: ReactNode }) {
  return (
    <li className='flex gap-2.5 text-base leading-relaxed text-ink-2'>
      <span
        aria-hidden='true'
        className='mt-2 h-1.5 w-1.5 shrink-0 rounded-full'
        style={{ backgroundColor: 'var(--rp-accent)' }}
      />
      <span>{children}</span>
    </li>
  )
}

function Steps({ children }: { children: ReactNode }) {
  return (
    <ol className='space-y-3 pl-5 text-base leading-relaxed text-ink-2 marker:font-semibold marker:text-ink-3'>
      {children}
    </ol>
  )
}

function Section(
  { id, children, wide, after }: {
    id: SectionId
    children: ReactNode
    wide?: boolean
    after?: ReactNode
  },
) {
  const { language } = usePortalLocale()
  const index = HOW_IT_WORKS_SECTIONS.findIndex((section) => section.id === id)
  const translated = language === 'ja'
    ? HELP_PAGES_JA['how-this-works']?.sections[index]
    : undefined
  return (
    <section id={id} className='scroll-mt-24'>
      <h2 className='rp-display text-xl text-ink'>
        {translated?.heading ?? headingFor(id)}
      </h2>
      <div className={`mt-3 space-y-3.5 ${wide ? '' : 'rp-measure rp-prose'}`}>
        {translated && id !== 'tools' ? <HelpMarkdown text={translated.body} /> : children}
        {after}
      </div>
    </section>
  )
}

function P({ children }: { children: ReactNode }) {
  return <p className='text-base leading-relaxed text-ink-2'>{children}</p>
}

/** A link inside running prose: accent ink and an underline, so it reads as a link. */
function TextLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className='rp-focus rounded-[var(--rp-radius-btn)] font-medium underline underline-offset-2'
      style={{ color: 'var(--rp-accent-fg)' }}
    >
      {children}
    </Link>
  )
}

function OnThisPage() {
  const { language, ui } = usePortalLocale()
  return (
    <nav aria-label={ui('On this page')} className='space-y-0.5'>
      <p className='rp-eyebrow px-2 text-ink-3'>{ui('On this page')}</p>
      <ul className='mt-1.5 space-y-0.5'>
        {HOW_IT_WORKS_SECTIONS.map((section, index) => (
          <li key={section.id}>
            <a
              href={`#${section.id}`}
              className='rp-link-standalone rp-focus flex w-full justify-start rounded-[var(--rp-radius-btn)] px-2 py-1.5 text-sm text-ink-2 transition-colors duration-150 hover:bg-[var(--rp-surface-2)] hover:text-ink'
            >
              {language === 'ja'
                ? HELP_PAGES_JA['how-this-works']!.sections[index]!.heading
                : section.heading}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}

type Tool = { title: string; detail: string; path: string }

function tools(slug: string): Tool[] {
  const base = `/t/${slug}`
  return [
    {
      title: 'Search',
      detail: 'Finds documents fast, with a short cited answer over them or the results alone.',
      path: `${base}/search`,
    },
    {
      title: 'Ask',
      detail:
        'The full conversation: a grounded, cited answer, follow-ups that keep the context, saved sessions and deep research for broad questions.',
      path: `${base}/ask`,
    },
    {
      title: 'Library and the reader',
      detail: 'Browse the whole collection and open any paper at the cited passage.',
      path: `${base}/library`,
    },
    {
      title: 'Chat with a document',
      detail:
        "Ask questions of one paper alone, from its page in the reader. Its answers are checked against that document's own text and badged the same way.",
      path: `${base}/library`,
    },
    {
      title: 'Investigations',
      detail: 'Gather evidence around a research question over time and synthesise it.',
      path: `${base}/investigations`,
    },
    {
      title: 'Generate',
      detail:
        'A briefing, comparison, timeline or set of questions and answers from the collection, with references.',
      path: `${base}/generate`,
    },
    {
      title: 'Assessment',
      detail: 'A knowledge check built on any area of the collection.',
      path: `${base}/assessment`,
    },
    {
      title: 'The knowledge map',
      detail:
        'The conditions, genes, medications, researchers and institutions in the collection, and how they connect.',
      path: `${base}/graph`,
    },
    {
      title: 'Watches',
      detail:
        'Re-run a search or a question daily and flag it when the collection has something new.',
      path: `${base}/search`,
    },
    {
      title: 'Exports',
      detail:
        'An answer trail, an investigation or a generated artefact as a Word document; a briefing as a print-ready copy for saving as a PDF (portable document format) file.',
      path: `${base}/help/getting-started#exporting-your-work`,
    },
  ]
}

function ToolCard({ tool }: { tool: Tool }) {
  const { ui } = usePortalLocale()
  return (
    <Link
      to={tool.path}
      className='rp-card rp-focus group flex min-h-full flex-col gap-2 p-5 no-underline transition-colors duration-150 hover:bg-[var(--rp-surface-2)] lg:p-6'
    >
      <span className='flex items-center justify-between gap-2'>
        <span className='text-base font-semibold text-ink'>{ui(tool.title)}</span>
        <ArrowRight size='sm' className='text-ink-3' />
      </span>
      <span className='text-sm leading-relaxed text-ink-2'>{ui(tool.detail)}</span>
    </Link>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function HowItWorksPage() {
  const { ui, number, language } = usePortalLocale()
  const { config } = useOutletContext<TenantOutletContext>()
  const slug = config.slug
  const counters = useQuery({
    queryKey: ['counters', slug],
    queryFn: () => getCounters(slug),
    staleTime: 60_000,
    retry: false,
  })
  const intents = config.intents ?? []

  return (
    <main className='rp-shell py-8 lg:py-10'>
      <div className='mb-6'>
        <p className='rp-eyebrow text-ink-3'>{ui('Help')}</p>
        <h1 className='rp-display mt-1 text-2xl text-ink sm:text-3xl'>
          {ui('How this works')}
        </h1>
        <p className='rp-measure mt-2 text-sm leading-relaxed text-ink-2'>
          {ui(
            'How {name} turns a collection of papers into cited answers, and what it checks before it shows you one.',
            { name: config.branding.productName },
          )}
        </p>
      </div>

      <div className='mt-6 space-y-6 lg:space-y-8'>
        <LiveFigures counters={counters.data} pending={counters.isPending} />
        <FlowDiagram />
      </div>

      <div className='mt-6 grid grid-cols-1 gap-8 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-10 2xl:grid-cols-[16rem_minmax(0,1fr)]'>
        <aside className='hidden lg:block'>
          <div className='lg:sticky lg:top-[calc(var(--rp-header-h,_4rem)_+_var(--spacing)_*_4)]'>
            <OnThisPage />
          </div>
        </aside>

        <div className='min-w-0 space-y-6 lg:space-y-8'>
          <Section
            id='content'
            after={
              <P>
                {counters.data && (
                  <>
                    {ui(
                      'The collection currently holds {resources} resources, indexed as {paragraphs} paragraphs and {sentences} sentences.',
                      {
                        resources: number(counters.data.resources),
                        paragraphs: number(counters.data.paragraphs),
                        sentences: number(counters.data.sentences),
                      },
                    )}
                    {' '}
                  </>
                )}
                {language === 'en' ? 'The ' : null}
                <TextLink to={`/t/${slug}/library`}>{ui('Library')}</TextLink>
                {language === 'en' ? ' ' : null}
                {counters.data
                  ? ui('lists every one of them.')
                  : ui('lists every resource in the collection and shows the current count.')}
              </P>
            }
          >
            <P>
              The portal reads one collection: research papers, their supplementary files and video
              material, loaded into the portal's knowledge index by the people who run it. Nothing
              else is read. What you can search, ask and browse is exactly what is in that
              collection.
            </P>
          </Section>

          <Section id='ingest'>
            <P>Every document goes through the same steps before it can be found:</P>
            <Steps>
              <li>
                <strong className='font-semibold text-ink'>Text and tables are extracted</strong>
                {' '}
                from the file page by page, so a passage can later be traced back to where it sits
                in the paper. Video material is transcribed.
              </li>
              <li>
                <strong className='font-semibold text-ink'>
                  Enrichment agents read the extracted text
                </strong>{' '}
                and write a plain-language summary and key takeaways, assign topic and study-design
                labels, label individual passages, and record the relations between the entities the
                paper mentions (conditions, genes, medications, researchers and institutions) for
                the knowledge graph.
              </li>
              <li>
                <strong className='font-semibold text-ink'>
                  The document, its passages and its labels are indexed
                </strong>{' '}
                for retrieval by meaning and by exact term.
              </li>
            </Steps>
            <P>
              The original file is never altered. The generated fields sit beside it and are shown
              on the document page as generated fields, never as the paper's own words.
            </P>
          </Section>

          <Section
            id='answered'
            after={intents.length > 0
              ? (
                <div className='rounded-[var(--rp-radius)] border border-line bg-surface-2 p-4'>
                  <p className='rp-eyebrow text-ink-3'>{ui('The configurations on this portal')}</p>
                  <dl className='mt-2 space-y-2'>
                    {intents.map((intent) => (
                      <div key={intent.id} className='text-sm leading-relaxed'>
                        <dt className='inline font-semibold text-ink'>{intent.label}.</dt>{' '}
                        <dd className='inline text-ink-2'>{intent.description}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )
              : null}
          >
            <P>Four things happen between the question and the answer:</P>
            <Steps>
              <li>
                <strong className='font-semibold text-ink'>The question is routed.</strong>{' '}
                The portal reads the question and chooses the retrieval configuration that suits it.
                The choice is shown beside the answer as a chip, and you can change it and ask
                again.
              </li>
              <li>
                <strong className='font-semibold text-ink'>The index returns the passages.</strong>
                {' '}
                The chosen configuration retrieves the passages that match the question, by meaning
                and by exact term, and ranks them. A study the question names by title or acronym is
                looked up by name and pinned into the sources, so it cannot be crowded out of them;
                when the collection does not hold that study, the answer says so rather than
                answering from a paper that only cites it.
              </li>
              <li>
                <strong className='font-semibold text-ink'>
                  A question that asks for a number is answered one paper at a time.
                </strong>{' '}
                A question that asks for a rate, a proportion, an age or a comparison is broken into
                its clauses first, each clause is resolved to the one paper that answers it, and
                each is answered from that paper alone. The answers are put together so that every
                sentence carries exactly one citation: no sentence draws on two papers, because no
                part of the answer was written with two papers in front of it. Where a clause has no
                paper, the answer says so for that clause and answers the rest.
              </li>
              <li>
                <strong className='font-semibold text-ink'>
                  The answer is written only from those passages.
                </strong>{' '}
                Nothing is drawn from general knowledge or from the internet. Every sentence that
                states a finding carries a citation to the passage it came from (an item in a list
                takes the citation of the paragraph it belongs to), and opening the citation shows
                that passage in the paper.
              </li>
            </Steps>
          </Section>

          <Section id='checked'>
            <P>
              Before an answer is shown, the portal checks it against the cited text, sentence by
              sentence:
            </P>
            <ul className='space-y-2 pl-1'>
              <Bullet>
                <strong className='font-semibold text-ink'>Figures.</strong>{' '}
                Every number, percentage, dose and range in a sentence is first located in the cited
                paper, and the sentence or table row that carries it there must share the claim's
                own quantity - its outcome, the noun the figure measures or the name the question
                asked about - about the same outcome, at the same follow-up, with the same responder
                threshold and the same denominator. A figure the cited passage does not carry is
                looked for in the full text of the retrieved papers: where one of them carries it
                beside the same claim, the sentence is cited to that paper instead; where the figure
                is there but cannot be tied to the claim as the answer stated it, the sentence is
                removed and that paper's own sentence on the outcome you asked about is quoted in
                its place. A figure found nowhere means the sentence is removed, and the answer says
                that it was.
              </Bullet>
              <Bullet>
                <strong className='font-semibold text-ink'>Populations.</strong>{' '}
                When the question names a cohort, trial or study, every sentence with a figure must
                cite a paper about that cohort, and a figure the cited paper only quotes from other
                studies is removed rather than annotated, so a figure from a different population
                cannot be passed off as the one you asked about. Where the question names no cohort,
                such a figure is kept but marked as second-hand, with the paper's own finding beside
                it, so you can see what it rests on.
              </Bullet>
              <Bullet>
                <strong className='font-semibold text-ink'>Named studies.</strong>{' '}
                A sentence cited to the wrong paper is replaced by the named paper's own sentence
                only when that sentence carries the same figure at the same time point, quoted
                verbatim and cited; otherwise the sentence is removed, and a named paper the answer
                never cited is read directly before anything is declined. A denominator the answer
                pairs with a figure is checked as part of the figure: a pairing the paper
                contradicts is removed and said so, never rewritten, and a denominator is only ever
                added from the figure's own bracket or table cell. When the papers that answer one
                question describe different populations, each sentence says which paper it comes
                from; a protocol's planned recruitment is named as such beside the results paper's
                enrolment.
              </Bullet>
              <Bullet>
                <strong className='font-semibold text-ink'>Years and safety verbs.</strong>{' '}
                A year must come from a cited resource. A medication the answer calls
                contraindicated must be called that, by name, in a cited passage: the verb is read
                with the medication nearest it, so a passage calling a different drug
                contraindicated is not support, and a passage that only calls the drug "not
                recommended" or says it may aggravate seizures does not carry the stronger word.
                Where the sources say something weaker, the answer says so and quotes what they do
                say. The same holds for "should be avoided", a boxed warning and "first-line", and a
                medication the cited sources flag is never dropped silently.
              </Bullet>
            </ul>
            <P>
              While the answer is still streaming, its text is shown as unchecked (muted, with a
              "still streaming, the check follows" mark), its first complete sentence is checked
              against the papers retrieval found and, when it passes, the paper that carries it is
              named under the answer; the checked answer then replaces the streamed text. A
              follow-up in the same conversation carries the earlier answers' cited papers with it:
              a question about "that study" is answered from those papers, with their own paragraphs
              and tables in front of the generator, and a request to put the earlier answers in a
              table keeps every row, with any cell the check could not verify - a figure it could
              not tie to that row's source, or an analysis set name where the column asked for a
              figure - marked "not verified" rather than the row dropped. Chat with a document runs
              the same check against that document's own text and shows the same badge.
            </P>
            <P>
              These checks are plain text comparisons against the extracted text of the papers, with
              no language model in the loop, so the check cannot invent support. The confidence
              label under the answer is led by that check: an unverified figure, year or
              contraindication marks it low, removed sentences cap it at moderate, and high is
              earned only when every figure was found. The platform's own quality scoring of how
              well the answer addresses the question, how firmly it is grounded and how relevant the
              retrieved passages were can lower the label but never raise it, and is shown as the
              platform's self-assessment. The check decides: a fluent answer whose figures the cited
              papers do not carry is not shown as high confidence.
            </P>
          </Section>

          <Section id='tools' wide>
            <div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5'>
              {tools(slug).map((tool) => <ToolCard key={tool.title} tool={tool} />)}
            </div>
          </Section>

          <Section id='limits'>
            <ul className='space-y-2 pl-1'>
              <Bullet>
                It never answers without a source. When nothing relevant is found, the answer is
                replaced by the portal's own decline and the closest passages it found. When an
                answer draws on relevant sources but cannot be linked to specific passages, it says
                so and lists the sources it consulted, unless this portal declines such answers.
              </Bullet>
              <Bullet>
                It says plainly when the collection does not hold something, and shows the closest
                passages it found, rather than filling the gap. A study the question names that no
                paper here reports is named in the decline.
              </Bullet>
              <Bullet>
                When a sentence is removed, what rested on it goes too: the conclusion drawn from
                it, and the opening answer when nothing else left in the answer stands behind it.
              </Bullet>
              <Bullet>
                It does not browse the internet. Every answer comes from the collection alone.
              </Bullet>
              <Bullet>
                It does not change the papers. Extraction and enrichment sit beside the original,
                which stays exactly as published.
              </Bullet>
            </ul>
          </Section>

          <Section
            id='under-the-hood'
            after={
              <p className='text-sm text-ink-3'>
                {ui('More on reading an answer:')}{' '}
                <TextLink to={`/t/${slug}/help/trust-and-citations`}>
                  {ui('Trust, citations and confidence')}
                </TextLink>
                {language === 'ja' ? '。' : '.'}
              </p>
            }
          >
            <div className='rounded-[var(--rp-radius)] border border-line bg-surface-2 p-4 sm:p-5'>
              <p className='rp-eyebrow text-ink-3'>For technical readers</p>
              <p className='mt-2 text-sm leading-relaxed text-ink-2'>
                The knowledge index, retrieval, answer generation, citations, the answer quality
                signal, the enrichment agents and the entity relations graph are provided by
                Progress Agentic RAG (retrieval-augmented generation), the knowledge platform the
                portal runs on. The portal adds the intent routing, the verification layer described
                above, and the reading tools: the reader, document chat, investigations, generation,
                assessment, watches and exports. The platform sits behind one retrieval interface in
                the portal, and the credentials for it never reach the browser.
              </p>
            </div>
          </Section>
        </div>
      </div>
    </main>
  )
}
