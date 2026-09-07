import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  cleanFormatLeaks,
  corpusDecline,
  dropEmptyHeadings,
  dropHeaderOnlyTables,
  endsMidSentence,
  forwardableSlice,
  looksLikeProviderDecline,
  referenceBlockStart,
  rewriteSentinels,
  SentinelStream,
  stripCodeFences,
  stripFenceLines,
  stripModelReferences,
  trimTruncatedTail,
  withheldDecline,
} from './answer-shape.ts'

describe('stripModelReferences', () => {
  it('removes a trailing model-authored reference list and the rule above it', () => {
    const text =
      'ATL is effective [1].\n\n---\n\n**References:**\n1. Study on LITT efficacy at 12 months.\n2. Study on ATL long-term efficacy.'
    expect(stripModelReferences(text)).toBe('ATL is effective [1].')
  })

  it('handles a markdown heading and bracketed entries', () => {
    const text = 'Body.\n\n### Sources\n[1] ViEEG paper\n[2] Network models'
    expect(stripModelReferences(text)).toBe('Body.')
  })

  it('strips a trailing bracketed reference list that has no heading', () => {
    const text = 'ATL gave 30% seizure freedom at 25 years [1].\n\n' +
      '[1] Extended follow-up after anterior temporal lobectomy.\n' +
      '[2] Stereo-electroencephalography-guided thermocoagulation: a review.'
    expect(stripModelReferences(text)).toBe('ATL gave 30% seizure freedom at 25 years [1].')
    // Streaming: the first bracketed line holds the stream at the paragraph end.
    const partial = 'ATL gave 30% seizure freedom at 25 years [1].\n\n[1] Extended follow-up'
    expect(forwardableSlice(0, partial)).toEqual({
      text: 'ATL gave 30% seizure freedom at 25 years [1].',
      stop: true,
    })
  })

  it('leaves prose that merely mentions sources alone', () => {
    const text = 'The sources: three cohorts and one trial, all cited above.'
    expect(referenceBlockStart(text)).toBe(-1)
    expect(stripModelReferences(text)).toBe(text)
  })

  it('leaves a heading followed by prose alone', () => {
    const text = 'Body.\n\n## References\nThese come from the corpus and are listed in the panel.'
    expect(stripModelReferences(text)).toBe(text)
  })

  it('forwards a stream up to the heading, then stops', () => {
    const full = 'Answer text.\n\n**References:**\n1. one'
    const first = forwardableSlice(0, 'Answer text.')
    expect(first).toEqual({ text: 'Answer text.', stop: false })
    const second = forwardableSlice('Answer text.'.length, full)
    expect(second.stop).toBe(true)
    expect(second.text).toBe('')
    const third = forwardableSlice(0, full)
    expect(third).toEqual({ text: 'Answer text.', stop: true })
  })
})

describe('rewriteSentinels', () => {
  it('turns "the context" into "the cited sources" with plural agreement', () => {
    expect(rewriteSentinels('The context does not provide a rate.')).toBe(
      'The cited sources do not provide a rate.',
    )
    expect(rewriteSentinels('The provided context indicates a 5% rate.')).toBe(
      'The cited sources indicate a 5% rate.',
    )
    expect(rewriteSentinels('This is an inference rather than a claim from the context [3].'))
      .toBe('This is an inference rather than a claim from the cited sources [3].')
    expect(rewriteSentinels('The context is limited.')).toBe('The cited sources are limited.')
  })

  it('drops the guardrail sentence and the prompt coverage line, keeping the answer', () => {
    expect(
      rewriteSentinels(
        'Seizure freedom was 76% at 12 months [1].\n\nNot enough data to answer this fully.',
      ),
    ).toBe('Seizure freedom was 76% at 12 months [1].')
    expect(
      rewriteSentinels(
        "The paper reports a mean of 12.0 months. If you need more information, the portal's sources do not cover it.",
      ),
    ).toBe('The paper reports a mean of 12.0 months.')
    expect(rewriteSentinels('Therefore, "Not enough data to answer this."')).toBe('Therefore,')
  })

  it('is empty when the text was nothing but the template', () => {
    expect(rewriteSentinels('Not enough data to answer this.')).toBe('')
  })

  it('removes the inference marker in either bracket form (D5-16)', () => {
    expect(rewriteSentinels('Likely benign [inference].')).toBe('Likely benign.')
  })

  it('leaves ordinary uses of the word alone', () => {
    const text = 'In the clinical context of Dravet syndrome, avoid sodium channel blockers.'
    expect(rewriteSentinels(text)).toBe(text)
  })
})

describe('SentinelStream', () => {
  it('rewrites a phrase split across chunks and releases the rest at flush', () => {
    const stream = new SentinelStream()
    const out = [
      stream.push('Rates were 5%. The con'),
      stream.push('text does not report driving. Not enough data'),
      stream.push(' to answer this.'),
      stream.flush(),
    ].join('')
    expect(out.trim()).toBe('Rates were 5%. The cited sources do not report driving.')
  })

  it('streams whole sentences as soon as the next one has started', () => {
    const stream = new SentinelStream()
    expect(stream.push('First sentence. Second')).toBe('First sentence. ')
    // The second sentence goes out as soon as its stop arrives (D3-05).
    expect(stream.push(' sentence.')).toBe('Second sentence.')
    expect(stream.flush()).toBe('')
  })
})

describe('decline copy', () => {
  it('names the nearest matches and the match strength', () => {
    const text = corpusDecline(['A first paper', 'A second paper'], 21)
    expect(text).toContain('best match 21%')
    expect(text).toContain('*A first paper* and *A second paper* - listed below but not used')
    expect(corpusDecline([])).not.toContain('closest matches')
    const none = corpusDecline(['A near miss'], 12, { noCloseMatch: true })
    expect(none).toContain('No source in the corpus comes close to this question')
    expect(none).not.toContain('A near miss')
    expect(none).toContain('best match 12%')
  })

  it('recognises the provider decline strings so the handler can hold them', () => {
    expect(
      looksLikeProviderDecline("This portal's content does not hold enough relevant material"),
    ).toBe(true)
    expect(looksLikeProviderDecline('Seizure freedom was 76%.')).toBe(false)
  })
})

describe('stripModelReferences - trailing author-year and title entries', () => {
  it('cuts an author-year reference the model appended to its last paragraph', () => {
    const text =
      'JME shows 10-16 Hz polyspikes.[1][2] Seneviratne et al. (2017). Electroencephalography in the Diagnosis of Genetic Generalized Epilepsy Syndromes.[1][2][3]'
    expect(stripModelReferences(text)).toBe('JME shows 10-16 Hz polyspikes.[1][2]')
  })

  it('cuts a run of bare cited titles after the conclusion', () => {
    const text =
      'Their findings suggest promising avenues for seizure prediction.[3] Multiday cycles of heart rate are associated with seizure likelihood: An observational cohort study.[1][2] Forecasting seizure likelihood from cycles of self-reported events and heart rate: a prospective pilot study.[1][2]'
    const titles = [
      'Multiday cycles of heart rate are associated with seizure likelihood: An observational cohort study',
      'Forecasting seizure likelihood from cycles of self-reported events and heart rate: a prospective pilot study',
    ]
    expect(stripModelReferences(text, titles)).toBe(
      'Their findings suggest promising avenues for seizure prediction.[3]',
    )
    // Without the titles the sentences read as prose and stand.
    expect(stripModelReferences(text)).toBe(text)
  })

  it('leaves an author-year mention that is followed by prose', () => {
    const text =
      'Marson et al. (2021) reported non-inferiority was not met.[1] This matters for IGE.'
    expect(stripModelReferences(text)).toBe(text)
  })
})

describe('trimTruncatedTail', () => {
  it('detects a text that stops on a dangling word or comma', () => {
    expect(endsMidSentence('Retention was 64.2%.[1] Therefore,')).toBe(true)
    expect(endsMidSentence('Retention was 64.2% and')).toBe(true)
    expect(endsMidSentence('Retention was 64.2% at 12 months in the')).toBe(true)
    expect(endsMidSentence('Retention was 64.2%.[1]')).toBe(false)
    expect(endsMidSentence('Retention was 64.2% (n = 1644).')).toBe(false)
    expect(endsMidSentence('**Conclusion:** the evidence is limited.')).toBe(false)
  })

  it('cuts back to the last complete sentence and says so', () => {
    expect(trimTruncatedTail('Seizure freedom was 23.2%.[1] Retention was 64.2%.[1] Therefore,'))
      .toEqual({ text: 'Seizure freedom was 23.2%.[1] Retention was 64.2%.[1]', truncated: true })
  })

  it('drops a dangling paragraph when an earlier paragraph is complete', () => {
    expect(trimTruncatedTail('A complete paragraph.[1]\n\nThe second one stops in the'))
      .toEqual({ text: 'A complete paragraph.[1]', truncated: true })
  })

  it('keeps a text with no complete sentence, flagged', () => {
    expect(trimTruncatedTail('Only a fragment that stops at the')).toEqual({
      text: 'Only a fragment that stops at the',
      truncated: true,
    })
  })

  it('leaves a complete text alone', () => {
    const text = 'One.[1] Two.[2]'
    expect(trimTruncatedTail(text)).toEqual({ text, truncated: false })
  })
})

describe('SentinelStream across line breaks', () => {
  it('holds the first letter of a sentinel that opens a new line until the phrase is complete', () => {
    const stream = new SentinelStream()
    let out = stream.push('Yes, lamotrigine is safe.\n\nThe')
    out += stream.push(' context does not provide information on dosing. More follows.')
    out += stream.flush()
    // Nothing of the sentinel leaks as a stray "T" ahead of the rewrite.
    expect(out).not.toMatch(/\nT\b/)
    expect(out).not.toContain('The context does not')
    expect(out).toContain('Yes, lamotrigine is safe.')
    expect(out).toContain('More follows.')
  })

  it('still releases a completed sentence through the space after it', () => {
    const stream = new SentinelStream()
    expect(stream.push('First sentence. Second')).toBe('First sentence. ')
    expect(stream.flush()).toBe('Second')
  })

  it('releases a sentence the moment it ends, without waiting for the next one (D3-05)', () => {
    const stream = new SentinelStream()
    expect(stream.push('The 12-month retention was 71.1% (n = 1644).')).toBe(
      'The 12-month retention was 71.1% (n = 1644).',
    )
    expect(stream.push(' The second')).toBe('')
    expect(stream.flush()).toBe(' The second')
  })

  it('holds a stop after a digit until the chunk that shows it was not a decimal point', () => {
    const stream = new SentinelStream()
    expect(stream.push('Retention was 71.')).toBe('')
    expect(stream.push('1% at 12 months.')).toBe('Retention was 71.1% at 12 months.')
    expect(stream.push('Enrolment ran to 2023.')).toBe('')
    expect(stream.flush()).toBe('Enrolment ran to 2023.')
  })

  it('still removes a template sentence that ends the buffer', () => {
    const stream = new SentinelStream()
    expect(stream.push('Not enough data to answer this.')).toBe('')
    expect(stream.push(' Rates were 5%.')).toBe(' Rates were 5%.')
  })
})

describe('withheldDecline', () => {
  it("names the figures that failed and the closest matches, in the portal's voice", () => {
    const text = withheldDecline(['Paper A', 'Paper B'], ['80%', '231', '12months'])
    expect(text).toContain('stated figures (80%, 231, 12 months) that no retrieved passage carries')
    expect(text).toContain('*Paper A*, *Paper B* - listed below')
    expect(text).not.toContain('not used')
    expect(text).toContain('Ask about one paper directly')
    expect(withheldDecline([], [])).not.toContain('closest matches')
    // Figures found somewhere in a paper are said to be, rather than "not used" (D3-15).
    expect(withheldDecline(['Paper A'], ['80%'], ['Paper C'])).toContain(
      'The figures were found in *Paper C* but could not be tied to the claim as the answer stated it.',
    )
  })
})

describe('table and list answers (D4-06)', () => {
  const table = [
    '| Drug | Study | Responder rate |',
    '|---|---|---|',
    '| Brivaracetam | EXPERIENCE | 36.9% (n = 822) |',
    '| Lacosamide | RCT | 68.1% (n = 119) |[1]',
  ].join('\n')
  it('treats a table whose last row closes with a pipe as complete', () => {
    expect(endsMidSentence(table)).toBe(false)
    expect(trimTruncatedTail(table)).toEqual({ text: table, truncated: false })
  })
  it('treats a row cut before its closing pipe as truncated and drops only that row', () => {
    const cut = table + '\n| Perampanel | PERMIT | 58.3% (n ='
    expect(endsMidSentence(cut)).toBe(true)
    expect(trimTruncatedTail(cut)).toEqual({ text: table, truncated: true })
  })
  it('treats a list item ending on a figure or a bracket as complete', () => {
    expect(endsMidSentence('- Retention: 71.1% (n = 1644)')).toBe(false)
    expect(endsMidSentence('- Responder rate 58.3%')).toBe(false)
    expect(endsMidSentence('- Responder rate was')).toBe(true)
  })
})

describe('format leaks (D5-05, D5-16)', () => {
  it('strips a code fence around a table and leaves the table', () => {
    const fenced = '```markdown\n| A | B |\n|---|---|\n| 1 | 2 |\n```'
    expect(stripCodeFences(fenced)).toBe('| A | B |\n|---|---|\n| 1 | 2 |')
    expect(stripFenceLines('```markdown\n')).toBe('')
    expect(stripFenceLines('| 1 | 2 |\n')).toBe('| 1 | 2 |\n')
  })

  it('drops a heading whose section is empty and keeps one with content', () => {
    expect(dropEmptyHeadings('Intro.\n\n**Validation:**\n\n*One sentence was removed.*')).toBe(
      'Intro.\n\n*One sentence was removed.*',
    )
    expect(dropEmptyHeadings('### LGI1\n\n### NMDAR\n\nText.')).toBe('### NMDAR\n\nText.')
    expect(dropEmptyHeadings('### LGI1\n\nText.')).toBe('### LGI1\n\nText.')
  })

  it('removes a table left with a header and no rows', () => {
    expect(dropHeaderOnlyTables('Lead.\n\n| A | B |\n|---|---|\n\nTail.')).toBe('Lead.\n\nTail.')
    expect(dropHeaderOnlyTables('| A | B |\n|---|---|\n| 1 | 2 |')).toBe(
      '| A | B |\n|---|---|\n| 1 | 2 |',
    )
  })

  it('removes the inference token rather than restyling it', () => {
    expect(rewriteSentinels('This may be due to syncope (inference).[1]')).toBe(
      'This may be due to syncope.[1]',
    )
    expect(rewriteSentinels('Likely [inference] the case.')).toBe('Likely the case.')
  })

  it('cleans every leak at once and no longer reads a closing fence as a cut sentence', () => {
    const cleaned = cleanFormatLeaks('```markdown\n| A | B |\n|---|---|\n| 1 | 2 |\n```')
    expect(cleaned).toBe('| A | B |\n|---|---|\n| 1 | 2 |')
    expect(trimTruncatedTail(cleaned).truncated).toBe(false)
  })
})
