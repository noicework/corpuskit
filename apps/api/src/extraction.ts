/**
 * Extraction Lab (docs/EXTRACTION-LAB.md): profile a document, run it through
 * custom extraction methods in a sandbox knowledge box, measure the results,
 * and choose a routing rule per profile class. Everything here speaks the
 * portal's vocabulary; the platform shapes stay in the provider.
 */
import type {
  ExtractionClass,
  ExtractionMethod,
  ExtractionProfile,
  ExtractionRules,
  TenantConfig,
} from '@research-portal/core'
import type { AragProvider } from '@research-portal/retrieval'

// ---------------------------------------------------------------------------
// Profiling - pure classification over a small set of measurements.
// ---------------------------------------------------------------------------

export const THRESHOLDS = {
  /** Under this many characters per page the text layer is absent or useless. */
  imageOnlyChars: 100,
  /** Under this share of plausible words the text layer is garbled OCR. */
  garbledHitRate: 0.6,
  /** Over this many tabular rows per page the document is table-dense. */
  tableRowsPerPage: 8,
  /** Over this many pages an image-only document is a long scan. */
  longScanPages: 60,
}

/** Whether a token of four or more letters looks like a real word rather than OCR noise. */
export function plausibleWord(token: string): boolean {
  const w = token.toLowerCase()
  if (!/^[a-z]{4,}$/.test(w)) return false
  if (!/[aeiouy]/.test(w)) return false
  if (/([a-z])\1\1/.test(w)) return false
  if (/[bcdfghjklmnpqrstvwxz]{5,}/.test(w)) return false
  return true
}

/** Share of four-plus-letter tokens that look like words; 1 when there are none to judge. */
export function dictionaryHitRate(text: string): number {
  const tokens = text.match(/[A-Za-z]{4,}/g) ?? []
  if (tokens.length === 0) return 1
  const hits = tokens.filter(plausibleWord).length
  return Math.round((hits / tokens.length) * 1000) / 1000
}

/** Lines that read as table rows: markdown `|` rows, or three or more numeric cells in a line. */
export function tableRowCount(text: string): number {
  let rows = 0
  for (const line of text.split('\n')) {
    const l = line.trim()
    if (!l) continue
    if (/^\|.*\|$/.test(l) && !/^\|[\s|:-]+\|$/.test(l)) {
      rows++
      continue
    }
    const numeric = l.match(/(?:^|\s)[-+]?\d+(?:[.,]\d+)?%?(?=\s|$)/g)?.length ?? 0
    if (numeric >= 3 && l.split(/\s{2,}|\t/).length >= 3) rows++
  }
  return rows
}

export function classify(
  p: Pick<
    ExtractionProfile,
    'pages' | 'charsPerPage' | 'tableRowsPerPage' | 'dictionaryHitRate' | 'imageOnlyPages'
  >,
): ExtractionClass {
  const imageOnly = p.charsPerPage < THRESHOLDS.imageOnlyChars ||
    (p.pages > 0 && p.imageOnlyPages / p.pages > 0.8)
  if (imageOnly) return p.pages > THRESHOLDS.longScanPages ? 'long-scan' : 'image-only'
  if (p.dictionaryHitRate < THRESHOLDS.garbledHitRate) return 'garbled-text'
  if (p.tableRowsPerPage > THRESHOLDS.tableRowsPerPage) return 'tables'
  return 'prose'
}

/** Build a profile from extracted text (page breaks as form feeds when known). */
export function profileFromText(
  input: {
    text: string
    pages?: number
    bytes: number
    fonts?: number
    source: ExtractionProfile['source']
  },
): ExtractionProfile {
  const pageTexts = input.text.includes('\f') ? input.text.split('\f') : [input.text]
  const pages = Math.max(1, input.pages ?? pageTexts.length)
  const chars = input.text.replace(/\s+/g, ' ').trim().length
  const imageOnlyPages = input.text.includes('\f')
    ? pageTexts.filter((t) => t.replace(/\s+/g, ' ').trim().length < THRESHOLDS.imageOnlyChars)
      .length
    : (chars / pages < THRESHOLDS.imageOnlyChars ? pages : 0)
  const partial = {
    pages,
    bytes: input.bytes,
    chars,
    charsPerPage: Math.round(chars / pages),
    fonts: input.fonts ?? 0,
    imageOnlyPages,
    tableRowsPerPage: Math.round((tableRowCount(input.text) / pages) * 10) / 10,
    dictionaryHitRate: dictionaryHitRate(input.text),
    source: input.source,
  }
  return { ...partial, class: classify(partial) }
}

/** Which method the rules choose for a profile. */
export function chooseMethod(
  rules: ExtractionRules | undefined,
  profile: ExtractionProfile,
  methods: ExtractionMethod[],
): string {
  if (!rules) return 'default'
  const rule = rules.rules.find((r) => r.when === profile.class)
  let method = rule?.method ?? rules.default
  const chosen = methods.find((m) => m.id === method)
  if (chosen?.kind === 'visual' && rules.visualPageCap && profile.pages > rules.visualPageCap) {
    method = rules.default
  }
  return method
}

// ---------------------------------------------------------------------------
// Poppler on the host - pdfinfo / pdftotext / pdffonts - with a text fallback.
// ---------------------------------------------------------------------------

async function run(cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const p = new Deno.Command(cmd, { args, stdout: 'piped', stderr: 'null' })
    const { code, stdout } = await p.output()
    return { ok: code === 0, out: new TextDecoder().decode(stdout) }
  } catch {
    return { ok: false, out: '' }
  }
}

export async function popplerAvailable(): Promise<boolean> {
  return (await run('pdfinfo', ['-v'])).ok || (await run('pdftotext', ['-v'])).ok
}

/** Profile a PDF with poppler; null when poppler is unavailable. */
export async function profilePdf(bytes: Uint8Array): Promise<ExtractionProfile | null> {
  if (!(await popplerAvailable())) return null
  // Temp files live under the data directory, which the server may already
  // write to; the system temp dir needs no extra permission that way.
  const dir = `${Deno.env.get('DATA_DIR') ?? './data'}/tmp`
  await Deno.mkdir(dir, { recursive: true }).catch(() => {})
  const tmp = await Deno.makeTempFile({ dir, suffix: '.pdf' })
  try {
    await Deno.writeFile(tmp, bytes)
    const info = await run('pdfinfo', [tmp])
    const pages = Number(/Pages:\s+(\d+)/.exec(info.out)?.[1] ?? 0) || undefined
    const text = await run('pdftotext', ['-layout', tmp, '-'])
    const fontsOut = await run('pdffonts', [tmp])
    const fonts = fontsOut.ok ? Math.max(0, fontsOut.out.trim().split('\n').length - 2) : 0
    return profileFromText({ text: text.out, pages, bytes: bytes.length, fonts, source: 'poppler' })
  } finally {
    await Deno.remove(tmp).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// The sandbox box and the comparison job.
// ---------------------------------------------------------------------------

export function labTenant(config: TenantConfig): TenantConfig {
  return { ...config, slug: `${config.slug}-lab` }
}

export const LAB_METHOD_SPECS: Omit<ExtractionMethod, 'id'>[] = [
  { name: 'table-aware', kind: 'tables' },
  { name: 'visual-transcribe', kind: 'visual' },
]

/** The lab's methods, registering the standard custom ones when absent. */
export async function ensureLabMethods(
  provider: AragProvider,
  lab: TenantConfig,
): Promise<ExtractionMethod[]> {
  const existing = await provider.listExtractionMethods(lab)
  const out = [...existing]
  for (const spec of LAB_METHOD_SPECS) {
    if (!out.some((m) => m.name === spec.name)) {
      out.push(await provider.registerExtractionMethod(lab, spec))
    }
  }
  return out
}

export type CompareEvent =
  | { type: 'stage'; label: string }
  | { type: 'profile'; profile: ExtractionProfile; filename: string }
  | { type: 'method'; method: ExtractionMethod; metrics: MethodMetrics; textPreview: string }
  | { type: 'ask'; method: ExtractionMethod; question: string; answer: string; citations: number }
  | { type: 'error'; message: string; method?: string }
  | {
    type: 'done'
    purged: number
    recommended: string | null
    /** Why that method: the profile class and the evidence that decided it. */
    reason: string
    /** Characters per page relative to Default, for every method that finished. */
    yields: Record<string, number>
  }

export interface MethodMetrics {
  chars: number
  charsPerPage: number
  yieldVsDefault: number | null
  paragraphs: number
  tableRows: number
  dictionaryHitRate: number
  latencySec: number
  /** Pages the method sent through a vision model; the cost driver. */
  visionPages: number
  judgeScore: number | null
  judgeReason: string
}

/**
 * The judge-score margin by which the method a document's class calls for
 * must lose before another method is recommended over it. A table-dense
 * sheet extracted with 32 recovered table rows is the better extraction even
 * when the judge, reading a flattened preview, marks it a point lower for
 * "repeated text": the class decides, the judge only overrides on a clear
 * loss (P4-10).
 */
export const JUDGE_OVERRIDE_MARGIN = 2

/** Which method kind a profile class calls for. */
export function preferredKind(cls: ExtractionClass): ExtractionMethod['kind'] {
  switch (cls) {
    case 'tables':
      return 'tables'
    case 'image-only':
    case 'garbled-text':
    case 'long-scan':
      return 'visual'
    default:
      return 'default'
  }
}

const classLabel = (cls: ExtractionClass): string => {
  switch (cls) {
    case 'tables':
      return 'table-dense'
    case 'image-only':
      return 'image-only'
    case 'garbled-text':
      return 'garbled-text'
    case 'long-scan':
      return 'long-scan'
    default:
      return 'prose'
  }
}

/**
 * Recommend a method from the profile class first, the judge second.
 *
 * The class names the kind of method the document needs (tables -> the
 * table-aware method, image-only or garbled -> visual, prose -> default).
 * That method is recommended unless its judge score trails the best other
 * method by `JUDGE_OVERRIDE_MARGIN` or more, or it did not finish - in which
 * case the best-judged method wins, with recovered table rows and characters
 * as tie-breakers. Returns the method and a one-sentence reason.
 */
export function recommendMethod(
  cls: ExtractionClass,
  results: {
    method: ExtractionMethod
    metrics: Pick<MethodMetrics, 'judgeScore' | 'tableRows' | 'chars'>
  }[],
): { method: ExtractionMethod; reason: string } | null {
  if (results.length === 0) return null
  const byJudge = [...results].sort((a, b) =>
    (b.metrics.judgeScore ?? -1) - (a.metrics.judgeScore ?? -1) ||
    b.metrics.tableRows - a.metrics.tableRows || b.metrics.chars - a.metrics.chars
  )
  const best = byJudge[0]!
  const wanted = preferredKind(cls)
  const preferred = results.find((r) => r.method.kind === wanted)
  const score = (r: typeof best) => r.metrics.judgeScore
  const fmt = (r: typeof best) => score(r) === null ? 'unscored' : `${score(r)} / 5`
  if (!preferred) {
    return {
      method: best.method,
      reason: `${classLabel(cls)} document, but no ${wanted} method ran - ${best.method.name} ` +
        `scored best (${fmt(best)}).`,
    }
  }
  if (preferred.method.id === best.method.id) {
    return {
      method: preferred.method,
      reason: `${classLabel(cls)} document: ${preferred.method.name} is the method that class ` +
        `calls for and the judge agreed (${fmt(preferred)}` +
        (cls === 'tables' ? `, ${preferred.metrics.tableRows} table rows recovered).` : ').'),
    }
  }
  const gap = (score(best) ?? 0) - (score(preferred) ?? 0)
  if (score(preferred) !== null && gap < JUDGE_OVERRIDE_MARGIN) {
    return {
      method: preferred.method,
      reason: `${classLabel(cls)} document: ${preferred.method.name} is the method that class ` +
        `calls for` +
        (cls === 'tables' ? ` (${preferred.metrics.tableRows} table rows recovered)` : '') +
        `, and the judge's ${fmt(preferred)} is within ${JUDGE_OVERRIDE_MARGIN} points of ` +
        `${best.method.name}'s ${fmt(best)}.`,
    }
  }
  return {
    method: best.method,
    reason: `${classLabel(cls)} document would normally take ${preferred.method.name}, but the ` +
      `judge scored it ${fmt(preferred)} against ${best.method.name}'s ${fmt(best)} - a clear ` +
      `loss, so ${best.method.name} is recommended.`,
  }
}

const JUDGE_SCHEMA = {
  name: 'extraction_quality',
  description: 'Score the quality of an extracted document text',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      score: { type: 'integer', minimum: 0, maximum: 5 },
      reason: { type: 'string' },
    },
    required: ['score', 'reason'],
  },
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Read a production resource's main file bytes and name. */
async function fetchResourceFile(
  provider: AragProvider,
  config: TenantConfig,
  resourceId: string,
): Promise<{ bytes: Uint8Array; filename: string; contentType: string; title: string }> {
  const content = await provider.resourceContent(config, resourceId)
  const file = content?.files.find((f) => (f.contentType ?? '').includes('pdf')) ??
    content?.files[0]
  if (!content || !file) throw new Error('This resource has no file to extract')
  const res = await provider.fileStream(config, resourceId, file.fieldId)
  if (!res.ok) throw new Error(`Could not read the file (${res.status})`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  const filename = (content.title || resourceId).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) ||
    'document.pdf'
  return {
    bytes,
    filename: filename.toLowerCase().endsWith('.pdf') ? filename : `${filename}.pdf`,
    contentType: file.contentType ?? 'application/pdf',
    title: content.title,
  }
}

export async function profileResource(
  provider: AragProvider,
  config: TenantConfig,
  resourceId: string,
): Promise<{ profile: ExtractionProfile; filename: string }> {
  const file = await fetchResourceFile(provider, config, resourceId)
  const viaPoppler = await profilePdf(file.bytes)
  if (viaPoppler) return { profile: viaPoppler, filename: file.filename }
  const extracted = await provider.resourceExtraction(config, resourceId)
  return {
    profile: profileFromText({
      text: extracted.text,
      bytes: file.bytes.length,
      source: 'platform',
    }),
    filename: file.filename,
  }
}

/**
 * Run one document through the chosen methods in the sandbox, streaming a
 * result per method, then the before/after ask, then purge.
 */
export async function* compareExtraction(
  provider: AragProvider,
  config: TenantConfig,
  opts: {
    resourceId: string
    methods: string[]
    question?: string
    keep?: boolean
    timeoutSec?: number
  },
): AsyncGenerator<CompareEvent> {
  const lab = labTenant(config)
  const jobId = crypto.randomUUID().slice(0, 8)
  yield { type: 'stage', label: 'Reading the document' }
  const file = await fetchResourceFile(provider, config, opts.resourceId)
  const profile = (await profilePdf(file.bytes)) ??
    profileFromText({
      text: (await provider.resourceExtraction(config, opts.resourceId)).text,
      bytes: file.bytes.length,
      source: 'platform',
    })
  yield { type: 'profile', profile, filename: file.filename }

  yield { type: 'stage', label: 'Preparing the sandbox' }
  const available = await ensureLabMethods(provider, lab)
  const chosen = opts.methods
    .map((id) => available.find((m) => m.id === id || m.name === id))
    .filter((m): m is ExtractionMethod => m !== undefined)
  if (chosen.length === 0) {
    yield { type: 'error', message: 'None of the requested methods exist on the sandbox' }
    return
  }
  const uploaded: { method: ExtractionMethod; id: string; startedAt: number }[] = []
  yield {
    type: 'stage',
    label: `Extracting with ${chosen.length} method${chosen.length > 1 ? 's' : ''}`,
  }
  for (const method of chosen) {
    try {
      const { id } = await provider.uploadFile(lab, {
        filename: `lab-${jobId}-${method.name}-${file.filename}`,
        contentType: file.contentType,
        bytes: file.bytes,
        method: method.id,
      })
      await provider.patchResourceMeta(lab, id, {
        title: `${file.title} [${method.name}]`,
        tags: [`lab:${jobId}`],
      }).catch(() => {})
      uploaded.push({ method, id, startedAt: Date.now() })
    } catch (err) {
      yield {
        type: 'error',
        method: method.name,
        message: err instanceof Error ? err.message : 'upload failed',
      }
    }
  }
  const deadline = Date.now() + (opts.timeoutSec ?? 600) * 1000
  const results = new Map<string, MethodMetrics>()
  const pending = new Map(uploaded.map((u) => [u.id, u]))
  let defaultCharsPerPage: number | null = null
  while (pending.size > 0 && Date.now() < deadline) {
    await sleep(5000)
    for (const [id, u] of [...pending]) {
      const ex = await provider.resourceExtraction(lab, id).catch(() => null)
      if (!ex || (ex.status !== 'PROCESSED' && ex.status !== 'ERROR')) continue
      pending.delete(id)
      const latencySec = Math.round((Date.now() - u.startedAt) / 100) / 10
      if (ex.status === 'ERROR') {
        yield {
          type: 'error',
          method: u.method.name,
          message: 'The platform failed to process this document with that method',
        }
        continue
      }
      const charsPerPage = Math.round(ex.chars / Math.max(1, profile.pages))
      if (u.method.kind === 'default') {
        defaultCharsPerPage = charsPerPage
        // Methods that landed before Default get their yield now that the
        // baseline is known; the done event repeats the full map.
        for (const m of results.values()) {
          m.yieldVsDefault = Math.round((m.charsPerPage / Math.max(1, charsPerPage)) * 100) / 100
        }
      }
      let judgeScore: number | null = null
      let judgeReason = ''
      try {
        const judged = await provider.askStructured(
          lab,
          JUDGE_SCHEMA,
          'You are judging the quality of a document extraction for a research portal. Using only the text of this document as extracted, ' +
            'score 0 to 5 how complete and faithful the extraction looks (5 = clean prose and tables, nothing garbled; 0 = unusable noise), ' +
            'and give a one-sentence reason naming what is present or missing (tables, captions, garbled words).',
          { resourceId: id },
        )
        const obj = judged.object as { score?: unknown; reason?: unknown } | null
        if (obj && typeof obj.score === 'number') {
          judgeScore = Math.max(0, Math.min(5, Math.round(obj.score)))
        }
        if (obj && typeof obj.reason === 'string') judgeReason = obj.reason.slice(0, 240)
      } catch {
        judgeReason = 'Judge unavailable'
      }
      const metrics: MethodMetrics = {
        chars: ex.chars,
        charsPerPage,
        yieldVsDefault: defaultCharsPerPage
          ? Math.round((charsPerPage / Math.max(1, defaultCharsPerPage)) * 100) / 100
          : null,
        paragraphs: ex.paragraphs,
        tableRows: ex.tableRows,
        dictionaryHitRate: dictionaryHitRate(ex.text),
        latencySec,
        visionPages: u.method.kind === 'visual' ? profile.pages : 0,
        judgeScore,
        judgeReason,
      }
      results.set(u.method.id, metrics)
      yield { type: 'method', method: u.method, metrics, textPreview: ex.text.slice(0, 1600) }
    }
  }
  for (const u of pending.values()) {
    yield {
      type: 'error',
      method: u.method.name,
      message: 'Timed out waiting for the platform to process this document',
    }
  }
  // Relative yield once the default (or first) result is known.
  const baseline = defaultCharsPerPage ?? [...results.values()][0]?.charsPerPage ?? null
  if (baseline) {
    for (const m of results.values()) {
      m.yieldVsDefault = Math.round((m.charsPerPage / baseline) * 100) / 100
    }
  }

  // Before/after ask: the same question grounded on each extraction.
  const question = opts.question?.trim() ||
    'What was the main result of this document, with its numbers exactly as reported?'
  yield { type: 'stage', label: 'Asking the same question of each extraction' }
  for (const u of uploaded) {
    if (!results.has(u.method.id)) continue
    let answer = ''
    let citations = 0
    try {
      // The sandbox holds this one upload: no stored configuration (the
      // lab box has none), no score floor, and full-document grounding so
      // the whole extraction is in front of the model.
      for await (
        const event of provider.ask(lab, question, {
          resourceId: u.id,
          sandbox: true,
          depth: 'deep',
        })
      ) {
        if (event.type === 'delta') answer += event.text
        else if (event.type === 'citation') citations++
      }
    } catch (err) {
      answer = `Ask failed: ${err instanceof Error ? err.message : 'unknown error'}`
    }
    yield { type: 'ask', method: u.method, question, answer: answer.slice(0, 4000), citations }
  }

  let purged = 0
  if (!opts.keep) {
    for (const u of uploaded) {
      try {
        await provider.deleteResource(lab, u.id)
        purged++
      } catch {
        // best effort; the lab is scratch
      }
    }
  }
  const yields: Record<string, number> = {}
  for (const [id, m] of results) if (m.yieldVsDefault !== null) yields[id] = m.yieldVsDefault
  const recommendation = recommendMethod(
    profile.class,
    [...results.entries()].flatMap(([id, metrics]) => {
      const method = chosen.find((m) => m.id === id)
      return method ? [{ method, metrics }] : []
    }),
  )
  yield {
    type: 'done',
    purged,
    recommended: recommendation?.method.name ?? null,
    reason: recommendation?.reason ?? 'No method finished, so there is nothing to recommend.',
    yields,
  }
}
