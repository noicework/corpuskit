import {
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import type { TenantConfig } from '@research-portal/core'
import { getTitleIndex } from '../api/client.ts'
import { usePortalLocale } from '../lib/portal-locale.tsx'
import {
  buildSuggestions,
  flattenSuggestions,
  highlightRuns,
  type MatchRange,
  normaliseQuery,
  SUGGEST_MIN_CHARS,
  type Suggestion,
  type SuggestionGroup,
  type SuggestionGroupId,
} from '../lib/search-suggest.ts'
import { FileText, type IconComponent, MessageSquare, Search, Tag } from './icons.tsx'
import { LiveStatus, prettyLabel } from './ui.tsx'

/** How long typing has to pause before the list follows it. */
const SETTLE_MS = 150
/** The title index is a session's worth of data: refetched at most every ten minutes. */
const TITLE_INDEX_STALE_MS = 10 * 60 * 1000

export interface SearchSuggestOptions {
  config: TenantConfig
  query: string
  setQuery: (query: string) => void
  /** Which of the two free-text rows leads: the header searches, the hero asks. */
  primary: 'search' | 'ask'
  /** Called with a chosen suggestion, before the portal navigates to it. */
  onChosen?: (suggestion: Suggestion) => void
  /** The field's own question path, for the ask row and a suggested question; else Ask opens. */
  onAsk?: (text: string) => void
}

export interface SearchSuggestState {
  open: boolean
  groups: SuggestionGroup[]
  rows: Suggestion[]
  active: number
  setActive: (index: number) => void
  choose: (suggestion: Suggestion) => void
  listboxId: string
  optionId: (index: number) => string
  /** The polite result count, set once a pause in typing has settled the list. */
  announcement: string
  /** Spread onto the text input: the combobox role, its states and its keyboard. */
  inputProps: {
    role: 'combobox'
    'aria-autocomplete': 'list'
    'aria-expanded': boolean
    'aria-controls': string | undefined
    'aria-activedescendant': string | undefined
    autoComplete: 'off'
    value: string
    onChange: (event: ChangeEvent<HTMLInputElement>) => void
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
    onFocus: () => void
    onBlur: () => void
  }
}

/**
 * Suggestions for a search or ask field, as a WAI-ARIA 1.2 combobox with a listbox popup. The
 * documents come from one title list fetched the first time the field is used and kept for the
 * session; topics and suggested questions come from the portal's own configuration. Matching
 * happens here, so no keystroke reaches the server or the knowledge box.
 *
 * Up and Down move through the rows (Down also opens a closed list), Enter takes the highlighted
 * row or, with none, lets the form submit what was typed, Escape closes the list and then clears
 * the field, and Tab leaves. The highlighted row is carried by `aria-activedescendant`, so focus
 * never leaves the input.
 */
export function useSearchSuggest(
  { config, query, setQuery, primary, onChosen, onAsk }: SearchSuggestOptions,
): SearchSuggestState {
  const { ui } = usePortalLocale()
  const navigate = useNavigate()
  const listboxId = useId()
  const optionId = useCallback((index: number) => `${listboxId}-option-${index}`, [listboxId])
  const [wanted, setWanted] = useState(false)
  const [focused, setFocused] = useState(false)
  // Closed until the reader types: a field focused with text already in it stays quiet.
  const [dismissed, setDismissed] = useState(true)
  const [active, setActive] = useState(-1)
  const [settled, setSettled] = useState(query)
  const [announcement, setAnnouncement] = useState('')

  const { data: index } = useQuery({
    queryKey: ['title-index', config.slug],
    queryFn: () => getTitleIndex(config.slug),
    enabled: wanted,
    staleTime: TITLE_INDEX_STALE_MS,
    retry: 1,
  })

  useEffect(() => {
    // Too short to suggest from settles at once, so a cleared field never reopens on the list
    // its last query left behind while the next one is still being typed.
    if (normaliseQuery(query).length < SUGGEST_MIN_CHARS) {
      setSettled(query)
      return
    }
    const timer = setTimeout(() => setSettled(query), SETTLE_MS)
    return () => clearTimeout(timer)
  }, [query])

  const previous = useRef(query)
  useEffect(() => {
    if (previous.current === query) return
    previous.current = query
    setDismissed(false)
    setActive(-1)
  }, [query])

  const sources = useMemo(() => ({
    documents: index?.items ?? [],
    topics: config.topics,
    questions: config.suggestedQuestions,
  }), [index, config.topics, config.suggestedQuestions])

  const live = normaliseQuery(query)
  const built = useMemo(() => buildSuggestions(sources, settled, { primary }), [
    sources,
    settled,
    primary,
  ])
  // The search and ask rows always say what is in the field now, not what it held when the list
  // last settled, so choosing one never sends a stale query.
  const groups = useMemo(
    () =>
      built.map((group) =>
        group.id === 'actions'
          ? { ...group, items: group.items.map((item) => ({ ...item, text: live })) }
          : group
      ),
    [built, live],
  )
  const rows = useMemo(() => flattenSuggestions(groups), [groups])

  const open = focused && !dismissed && live.length >= SUGGEST_MIN_CHARS && rows.length > 0

  // A highlight belongs to the rows it was set on; a list that changed under it starts over.
  const rowsKey = rows.map((row) => `${row.type}:${'id' in row ? row.id : ''}`).join('|')
  useEffect(() => setActive(-1), [rowsKey])

  useEffect(() => {
    if (!open) {
      setAnnouncement('')
      return
    }
    setAnnouncement(
      rows.length === 1 ? ui('1 suggestion') : ui('{count} suggestions', { count: rows.length }),
    )
  }, [open, rowsKey, rows.length, ui])

  useEffect(() => {
    if (!open || active < 0) return
    document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' })
  }, [open, active, optionId])

  const close = useCallback(() => {
    setDismissed(true)
    setActive(-1)
  }, [])

  const choose = useCallback((suggestion: Suggestion) => {
    const base = `/t/${config.slug}`
    const typed = normaliseQuery(query)
    if (onAsk && (suggestion.type === 'ask' || suggestion.type === 'question')) {
      close()
      onChosen?.(suggestion)
      onAsk(suggestion.type === 'ask' ? typed : suggestion.text)
      return
    }
    const to = suggestion.type === 'document'
      ? `${base}/library/${encodeURIComponent(suggestion.id)}`
      : suggestion.type === 'topic'
      ? `${base}/library?topic=${encodeURIComponent(suggestion.id)}`
      : suggestion.type === 'question'
      ? `${base}/ask?ask=${encodeURIComponent(suggestion.text)}`
      : suggestion.type === 'search'
      ? `${base}/search?q=${encodeURIComponent(typed)}`
      : `${base}/ask?ask=${encodeURIComponent(typed)}`
    close()
    onChosen?.(suggestion)
    navigate(to)
  }, [close, config.slug, navigate, onAsk, onChosen, query])

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    switch (event.key) {
      case 'ArrowDown': {
        if (live.length < SUGGEST_MIN_CHARS || rows.length === 0) return
        event.preventDefault()
        if (!open) {
          setDismissed(false)
          setActive(0)
          return
        }
        setActive((previousIndex) => (previousIndex + 1) % rows.length)
        return
      }
      case 'ArrowUp': {
        if (!open) return
        event.preventDefault()
        setActive((previousIndex) => (previousIndex <= 0 ? rows.length - 1 : previousIndex - 1))
        return
      }
      case 'Enter': {
        const row = open && active >= 0 ? rows[active] : undefined
        if (row) {
          event.preventDefault()
          choose(row)
          return
        }
        // Nothing highlighted: the form submits what was typed.
        close()
        return
      }
      case 'Escape': {
        if (open) {
          event.preventDefault()
          close()
          return
        }
        if (query.length > 0) {
          event.preventDefault()
          setQuery('')
        }
        return
      }
      case 'Tab':
        close()
        return
    }
  }

  return {
    open,
    groups,
    rows,
    active,
    setActive,
    choose,
    listboxId,
    optionId,
    announcement,
    inputProps: {
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-expanded': open,
      'aria-controls': open ? listboxId : undefined,
      'aria-activedescendant': open && active >= 0 ? optionId(active) : undefined,
      autoComplete: 'off',
      value: query,
      onChange: (event) => {
        setWanted(true)
        setQuery(event.target.value)
      },
      onKeyDown,
      onFocus: () => {
        setWanted(true)
        setFocused(true)
      },
      onBlur: () => setFocused(false),
    },
  }
}

const GROUP_HEADINGS: Record<Exclude<SuggestionGroupId, 'actions'>, string> = {
  documents: 'Documents',
  topics: 'Topics',
  questions: 'Suggested questions',
}

const ICONS: Record<Suggestion['type'], IconComponent> = {
  search: Search,
  ask: MessageSquare,
  document: FileText,
  topic: Tag,
  question: MessageSquare,
}

function Highlighted({ text, ranges }: { text: string; ranges: readonly MatchRange[] }) {
  return (
    <>
      {highlightRuns(text, ranges).map((run, index) =>
        run.match ? <mark key={index}>{run.text}</mark> : <span key={index}>{run.text}</span>
      )}
    </>
  )
}

/**
 * The suggestion list under a field. It is absolutely positioned, full width of its nearest
 * `relative` ancestor - the field's own wrapper - and keeps a polite live region mounted while
 * closed, so the count is read out when the list settles rather than on every keystroke.
 */
export function SearchSuggestPanel({ state, config }: {
  state: SearchSuggestState
  config: TenantConfig
}) {
  const { ui } = usePortalLocale()
  const { open, groups, active, setActive, choose, listboxId, optionId, announcement } = state
  const headingBase = `${listboxId}-group`
  const topicLabels = useMemo(
    () => new Map(config.topics.map((topic) => [topic.id, topic.label])),
    [config.topics],
  )

  const detailFor = (row: Suggestion): string | undefined => {
    if (row.type !== 'document') return undefined
    if (row.kind) return prettyLabel(row.kind, config.branding.organisation, ui)
    const topic = row.topicId ? topicLabels.get(row.topicId) : undefined
    if (topic) return topic
    if (row.resourceType === 'video') return ui('Video')
    if (row.resourceType === 'pdf') return ui('PDF')
    return undefined
  }

  const labelFor = (row: Suggestion): ReactNode => {
    if (row.type === 'search' || row.type === 'ask') {
      // The template carries the quotes and word order; the typed text is set in bold inside it.
      const marker = '\u0000'
      const template = row.type === 'search'
        ? ui('Search for “{query}”', { query: marker })
        : ui('Ask “{query}”', { query: marker })
      const [before = '', after = ''] = template.split(marker)
      return (
        <>
          {before}
          <mark>{row.text}</mark>
          {after}
        </>
      )
    }
    return <Highlighted text={row.text} ranges={row.ranges} />
  }

  let flat = -1
  const option = (row: Suggestion) => {
    const index = ++flat
    const Icon = ICONS[row.type]
    const detail = detailFor(row)
    const selected = index === active
    return (
      <div
        key={`${row.type}:${'id' in row ? row.id : index}`}
        id={optionId(index)}
        role='option'
        aria-selected={selected}
        onMouseMove={() => {
          if (!selected) setActive(index)
        }}
        onClick={() => choose(row)}
        className={`rp-suggest-option${selected ? ' rp-suggest-option-active' : ''}`}
      >
        <Icon size='sm' className='rp-suggest-icon shrink-0' />
        <span className='rp-suggest-text'>
          <span className='rp-suggest-label rp-clamp-2'>{labelFor(row)}</span>
          {detail && <span className='rp-suggest-detail'>{detail}</span>}
        </span>
      </div>
    )
  }

  return (
    <>
      <LiveStatus message={announcement} />
      {open && (
        <div
          className='rp-suggest-panel rp-card rp-shadow-lg absolute left-0 right-0 top-full z-50 mt-2 text-left'
          // Pressing inside the list must not take focus from the input, or the list would close
          // under the pointer before the click lands.
          onMouseDown={(event) => event.preventDefault()}
        >
          <div id={listboxId} role='listbox' aria-label={ui('Suggestions')}>
            {groups.map((group) => {
              if (group.id === 'actions') return group.items.map(option)
              const headingId = `${headingBase}-${group.id}`
              return (
                <div
                  key={group.id}
                  role='group'
                  aria-labelledby={headingId}
                  className='rp-suggest-group'
                >
                  <div id={headingId} role='presentation' className='rp-suggest-heading rp-eyebrow'>
                    {ui(GROUP_HEADINGS[group.id])}
                  </div>
                  {group.items.map(option)}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </>
  )
}
