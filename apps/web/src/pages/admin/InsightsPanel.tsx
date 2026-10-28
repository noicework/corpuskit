import type { Locale } from '../../lib/portal-locale.tsx'
import { englishUi } from './shared.ts'
import { relativeTime } from './shared.ts'
import { usePortalLocale } from '../../lib/portal-locale.tsx'
import { useAccess } from '../../components/AccessProvider.tsx'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { AnswerFeedbackSummary, AskInsightRow, InsightsSummary } from '../../api/client.ts'
import { getInsights } from '../../api/client.ts'
import { usePermissionAdminAccess } from '../../components/EmergencyAccess.tsx'
import { AdminAccessError } from '../../api/break-glass.ts'
import { Button, SectionHeader, Skeleton } from '../../components/ui.tsx'
import { RotateCw } from '../../components/icons.tsx'

function formatScore(value: number | null): string {
  return value === null ? '-' : `${value.toFixed(1)}/5`
}

function formatDuration(seconds: number | null, ui: Locale['ui'] = englishUi): string {
  return seconds === null ? '-' : ui('{count}s', { count: seconds.toFixed(1) })
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className='rounded-[var(--rp-radius)] bg-surface-2 px-4 py-3'>
      <dt className='rp-eyebrow text-2xs text-ink-3'>{label}</dt>
      <dd className='mt-1 text-2xl font-semibold tabular-nums text-ink'>{value}</dd>
    </div>
  )
}

/**
 * The answers readers marked unhelpful, with what they said was wrong and a way to ask the
 * question again: the clearest signal of what the collection needs next.
 */
export function UnhelpfulAnswers(
  { slug, feedback }: { slug: string; feedback: AnswerFeedbackSummary },
) {
  const { ui } = usePortalLocale()

  const rated = feedback.helpful + feedback.unhelpful
  return (
    <div className='rp-card p-5 lg:p-6' data-unhelpful-answers>
      <SectionHeader
        className='rp-manage-section-head'
        headingLevel={3}
        title={ui('Answers marked unhelpful')}
        description={ui(
          "Readers' thumbs-down ratings and what they said was wrong. Ask a question again to see the answer readers get now.",
        )}
      />
      <p className='mt-2 text-xs text-ink-3'>
        {rated === 0 ? ui('No answers rated yet') : ui(
          rated === 1
            ? '{unhelpful} of {rated} rated answer marked unhelpful'
            : '{unhelpful} of {rated} rated answers marked unhelpful',
          { unhelpful: feedback.unhelpful, rated },
        )}
      </p>
      {feedback.flagged.length === 0
        ? (
          <p className='mt-3 text-sm text-ink-3'>
            {ui('No answer has been marked unhelpful in the last 90 days.')}
          </p>
        )
        : (
          <ul className='mt-3 divide-y divide-line overflow-hidden rounded-[var(--rp-radius)] border border-line'>
            {feedback.flagged.map((item, index) => (
              <li key={index} className='bg-surface px-4 py-3'>
                <div className='flex flex-col items-start gap-2 sm:flex-row sm:justify-between'>
                  <p className='min-w-0 break-words text-sm font-medium text-ink'>
                    {item.question}
                  </p>
                  <Link
                    to={`/t/${slug}/ask?ask=${encodeURIComponent(item.question)}`}
                    className='rp-btn rp-btn-ghost rp-btn-sm shrink-0'
                    aria-label={ui('Ask again: {question}', { question: item.question })}
                  >
                    <RotateCw size='sm' />
                    {ui('Ask again')}
                  </Link>
                </div>
                {item.comment
                  ? (
                    <blockquote className='mt-1.5 break-words border-l-2 border-line pl-3 text-sm leading-relaxed text-ink-2'>
                      {item.comment}
                    </blockquote>
                  )
                  : <p className='mt-1.5 text-xs text-ink-3'>{ui('No comment left.')}</p>}
                <p className='mt-1 text-xs text-ink-3'>
                  {ui('Marked unhelpful ')}
                  {relativeTime(item.ratedAt, ui)}
                </p>
              </li>
            ))}
          </ul>
        )}
    </div>
  )
}

/**
 * This month's knowledge gaps, most asked first. Question text can hold personal data: the server
 * shortens it, and it is shown here, to curators and administrators, and never exported.
 */
export function MonthKnowledgeGaps(
  { gaps }: { gaps: NonNullable<InsightsSummary['knowledgeGaps']> },
) {
  const { ui, date } = usePortalLocale()
  const month = date(`${gaps.month}-01T00:00:00Z`, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
  return (
    <div className='rp-card p-5 lg:p-6' data-month-gaps>
      <SectionHeader
        className='rp-manage-section-head'
        headingLevel={3}
        title={ui('Top knowledge gaps in {month}', { month })}
        description={ui(
          'The questions asked most this month that the collection could not answer, or answered on weak grounding. Questions can hold personal data, so they are shortened, shown only to curators and administrators, and never exported.',
        )}
      />
      {gaps.questions.length === 0
        ? <p className='mt-3 text-sm text-ink-3'>{ui('No knowledge gaps this month.')}</p>
        : (
          <ol className='mt-3 divide-y divide-line overflow-hidden rounded-[var(--rp-radius)] border border-line'>
            {gaps.questions.map((gap, index) => (
              <li key={index} className='bg-surface px-4 py-2.5'>
                <div className='flex flex-col items-start gap-2 sm:flex-row sm:justify-between'>
                  <p className='min-w-0 break-words text-sm text-ink'>{gap.question}</p>
                  <span className='rp-tag shrink-0'>
                    {gap.asks} {gap.asks === 1 ? ui('ask') : ui('asks')}
                  </span>
                </div>
                <p className='mt-1 text-xs text-ink-3'>
                  {[
                    gap.unanswered > 0 ? ui('{count} unanswered', { count: gap.unanswered }) : '',
                    gap.weaklyGrounded > 0
                      ? ui('{count} weakly grounded', { count: gap.weaklyGrounded })
                      : '',
                    relativeTime(gap.lastAsked, ui),
                  ].filter(Boolean).join(' · ')}
                </p>
              </li>
            ))}
          </ol>
        )}
      <h4 className='mt-5 text-sm font-semibold text-ink'>{ui('Evidence coverage by topic')}</h4>
      <p className='mt-1 max-w-prose text-sm leading-relaxed text-ink-2'>
        {ui(
          "Not available: the ask log keeps each question's text but not its topic, and an unanswered question has no cited source to take a topic from.",
        )}
      </p>
    </div>
  )
}

/** A server's feedback summary, when it sent a well-formed one. */
function validFeedback(value: unknown): boolean {
  if (value === undefined) return true
  const feedback = value as Partial<AnswerFeedbackSummary> | null
  return !!feedback && Number.isFinite(feedback.helpful) &&
    Number.isFinite(feedback.unhelpful) && Array.isArray(feedback.flagged)
}

/**
 * The librarian's ask-analytics dashboard: what people are asking, how well
 * the corpus is answering, and - the hero of the panel - the specific
 * questions the corpus could not ground well, so the librarian knows exactly
 * what content to add next.
 */
function InsightsPanelContent({ slug }: { slug: string }) {
  const { ui, error: localError } = usePortalLocale()

  const { runExplicit, sessionAccess, sessionAllowed, pending } = usePermissionAdminAccess(
    'content.write',
    { kind: 'portal', slug },
  )
  const authority = useAccess()
  const context = authority.controller.context
  const assertCurrent = () => authority.controller.assertCurrent(context)
  const [snapshot, setSnapshot] = useState<Awaited<ReturnType<typeof getInsights>>>()
  const [error, setError] = useState<string>()
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ['admin-insights', slug],
    queryFn: () => getInsights(slug, sessionAccess),
    enabled: sessionAllowed,
    retry: false,
  })

  const { isLoading, isError, isFetching } = query
  const data = sessionAllowed ? query.data : snapshot
  const onRefresh = async () => {
    setError(undefined)
    try {
      const result = await runExplicit(ui('Read ask insights'), async (access) => {
        const insights = await getInsights(slug, access)
        if (
          !insights ||
          ![insights.totalAsks, insights.answered, insights.unanswered].every(Number.isFinite) ||
          ![insights.topQuestions, insights.gaps, insights.recent].every(Array.isArray) ||
          !validFeedback(insights.feedback) ||
          (insights.knowledgeGaps !== undefined &&
            !Array.isArray(insights.knowledgeGaps?.questions))
        ) throw new AdminAccessError()
        return insights
      })
      assertCurrent()
      if (result === undefined) return
      if (sessionAllowed) queryClient.setQueryData(['admin-insights', slug], result)
      else setSnapshot(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load insights.')
    }
  }

  return (
    <div className='space-y-4' data-admin-insights>
      <SectionHeader
        className='rp-manage-section-head'
        title={ui('Insights')}
        description={ui('What people are asking, and where the corpus is falling short.')}
        actions={
          <Button
            variant='ghost'
            size='sm'
            leadingIcon={RotateCw}
            disabled={pending || isFetching}
            onClick={() => void onRefresh()}
          >
            {isFetching ? ui('Refreshing…') : ui('Refresh insights')}
          </Button>
        }
      />

      {!sessionAllowed && (
        <p className='text-xs text-ink-3'>
          {ui('Insights are a snapshot. Refresh explicitly to read them again.')}
        </p>
      )}
      {error && (
        <p role='alert' className='text-sm text-[var(--rp-bad-ink)]'>
          {localError(error, 'Could not load insights.')}
        </p>
      )}
      {isLoading && (
        <div className='space-y-3'>
          <div className='grid grid-cols-[repeat(auto-fit,minmax(min(9rem,100%),1fr))] gap-3'>
            <Skeleton className='h-16 w-full' />
            <Skeleton className='h-16 w-full' />
            <Skeleton className='h-16 w-full' />
            <Skeleton className='h-16 w-full' />
          </div>
          <Skeleton className='h-40 w-full' />
        </div>
      )}

      {isError && <p className='text-sm text-ink-3'>{ui('Could not load insights.')}</p>}

      {data?.guardrails && (
        <dl
          className='grid grid-cols-[repeat(auto-fit,minmax(min(9rem,100%),1fr))] gap-3'
          data-guardrail-counts
        >
          <StatTile
            label={ui('Questions refused by policy')}
            value={String(data.guardrails.questionsRefused)}
          />
          <StatTile
            label={ui('Answers withheld for blocked terms')}
            value={String(data.guardrails.answersWithheld)}
          />
          <StatTile
            label={ui('Answers withheld for length')}
            value={String(data.guardrails.lengthWithheld)}
          />
        </dl>
      )}

      {data && data.totalAsks === 0 && (
        <div className='rounded-[var(--rp-radius)] border border-dashed border-line bg-surface-2 p-6'>
          <p className='text-sm font-semibold text-ink'>{ui('No questions asked yet')}</p>
          <p className='mt-1 max-w-xl text-sm leading-relaxed text-ink-2'>
            {ui('Insights appear once people start using Ask.')}
          </p>
        </div>
      )}

      {data && data.totalAsks > 0 && (
        <>
          <dl className='grid grid-cols-[repeat(auto-fit,minmax(min(9rem,100%),1fr))] gap-3'>
            <StatTile label={ui('Questions asked')} value={String(data.totalAsks)} />
            <StatTile label={ui('Answered')} value={String(data.answered)} />
            <StatTile label={ui('Unanswered')} value={String(data.unanswered)} />
            <StatTile
              label={ui('Avg groundedness')}
              value={data.avgGroundedness === null ? '-' : `${data.avgGroundedness.toFixed(1)}/5`}
            />
          </dl>

          {data.topQuestions.length > 0 && (
            <div className='rp-card p-5 lg:p-6'>
              <SectionHeader
                className='rp-manage-section-head'
                headingLevel={3}
                title={ui('Most asked')}
              />
              <ul className='mt-3 divide-y divide-line'>
                {data.topQuestions.map((q, index) => (
                  <li
                    key={index}
                    className='flex items-center justify-between gap-3 py-2 text-sm'
                  >
                    <span className='min-w-0 truncate text-ink-2'>{q.question}</span>
                    <span className='rp-tag shrink-0'>
                      {q.count} {q.count === 1 ? ui('ask') : ui('asks')}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className='rp-card p-5 lg:p-6'>
            <SectionHeader
              className='rp-manage-section-head'
              headingLevel={3}
              title={ui('Knowledge gaps')}
              description={ui(
                'Questions the corpus could not answer well - add sources that cover them to close the gap.',
              )}
            />
            {data.gaps.length === 0
              ? (
                <p className='mt-3 text-sm text-ink-3'>
                  {ui('No gaps found - the corpus is holding up.')}
                </p>
              )
              : (
                <ul className='mt-3 divide-y divide-line overflow-hidden rounded-[var(--rp-radius)] border border-line'>
                  {data.gaps.map((gap, index) => (
                    <li key={index} className='bg-surface px-4 py-2.5'>
                      <div className='flex flex-col items-start gap-2 sm:flex-row sm:justify-between'>
                        <p className='min-w-0 break-words text-sm text-ink'>{gap.question}</p>
                        <span
                          className='rp-badge rp-badge-warn shrink-0'
                          style={{ whiteSpace: 'normal' }}
                        >
                          {gap.reason === 'No answer found in the corpus'
                            ? ui('No answer found in the corpus')
                            : /^Weak grounding \(\d(?:\.\d+)?\/5\)$/.test(gap.reason)
                            ? ui('Weak grounding ({score}/5)', { score: gap.reason.slice(16, -3) })
                            : gap.reason}
                        </span>
                      </div>
                      <p className='mt-1 text-xs text-ink-3'>{relativeTime(gap.ts, ui)}</p>
                    </li>
                  ))}
                </ul>
              )}
          </div>

          {Array.isArray(data.knowledgeGaps?.questions) && (
            <MonthKnowledgeGaps gaps={data.knowledgeGaps!} />
          )}

          {data.feedback && validFeedback(data.feedback)
            ? <UnhelpfulAnswers slug={slug} feedback={data.feedback} />
            : null}

          <div className='rp-card p-5 lg:p-6'>
            <SectionHeader
              className='rp-manage-section-head'
              headingLevel={3}
              title={ui('Recent questions')}
            />
            {data.recent.length === 0
              ? <p className='mt-3 text-sm text-ink-3'>{ui('Nothing recent.')}</p>
              : (
                <div
                  className='rp-focus mt-3 overflow-x-auto'
                  role='region'
                  aria-label={ui('Recent questions')}
                  tabIndex={0}
                >
                  <table className='w-full min-w-[40rem] border-collapse text-sm'>
                    <thead>
                      <tr className='border-b border-line text-left text-xs text-ink-2'>
                        <th className='py-2 pr-3 font-semibold'>{ui('Question')}</th>
                        <th className='py-2 pr-3 font-semibold'>{ui('When')}</th>
                        <th className='py-2 pr-3 font-semibold'>{ui('Answered')}</th>
                        <th className='py-2 pr-3 text-right font-semibold'>{ui('Citations')}</th>
                        <th className='py-2 pr-3 text-right font-semibold'>{ui('Relevance')}</th>
                        <th className='py-2 pr-3 text-right font-semibold'>{ui('Grounded')}</th>
                        <th className='py-2 pr-3 text-right font-semibold'>{ui('Duration')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recent.map((row: AskInsightRow, index: number) => (
                        <tr key={index} className='border-b border-line last:border-0'>
                          <td className='max-w-xs truncate py-2 pr-3 text-ink'>{row.question}</td>
                          <td className='py-2 pr-3 text-ink-3'>{relativeTime(row.ts, ui)}</td>
                          <td className='py-2 pr-3'>
                            {row.answered
                              ? <span className='rp-badge rp-badge-ok'>{ui('Answered')}</span>
                              : <span className='rp-badge rp-badge-bad'>{ui('Unanswered')}</span>}
                          </td>
                          <td className='py-2 pr-3 text-right tabular-nums text-ink-2'>
                            {row.citations}
                          </td>
                          <td className='py-2 pr-3 text-right tabular-nums text-ink-2'>
                            {formatScore(row.answerRelevance)}
                          </td>
                          <td className='py-2 pr-3 text-right tabular-nums text-ink-2'>
                            {formatScore(row.groundedness)}
                          </td>
                          <td className='py-2 pr-3 text-right tabular-nums text-ink-2'>
                            {formatDuration(row.durationSec, ui)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </div>
        </>
      )}
    </div>
  )
}

/** Keep editors and protected snapshots within their authority generation. */
export function InsightsPanel(props: { slug: string }) {
  const authority = useAccess()
  const access = usePermissionAdminAccess('content.write', { kind: 'portal', slug: props.slug })
  if (authority.state.status !== 'ready' || (!access.sessionAllowed && !access.breakGlassEnabled)) {
    return null
  }
  return <InsightsPanelContent key={`${props.slug}:${authority.generation}`} {...props} />
}
