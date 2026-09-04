import { expect } from '@std/expect'
import { describe, it } from '@std/testing/bdd'
import { isEchoOfQuestion, passageContext, selectFollowUps } from './follow-up-questions.ts'

describe('passageContext()', () => {
  it('joins the retrieved passages under their titles', () => {
    const context = passageContext([
      { title: 'Oyster mortality trial', text: 'Summer mortality reached 42 per cent.' },
      { title: 'Hatchery report', text: 'Spat survival improved after the water change.' },
    ])
    expect(context).toContain('Oyster mortality trial: Summer mortality reached 42 per cent.')
    expect(context).toContain('Spat survival improved after the water change.')
  })

  it('gives every passage a share of the budget, not the first one all of it', () => {
    // The top hit is usually what the answer already used, so a budget the
    // first passage swallows whole strands the material a follow-up comes from.
    const context = passageContext([
      { title: 'A', text: 'alpha '.repeat(400) },
      { title: 'B', text: 'beta '.repeat(400) },
      { title: 'C', text: 'omegamarker '.repeat(40) },
    ], 900)
    expect(context).toContain('alpha')
    expect(context).toContain('beta')
    expect(context).toContain('omegamarker')
  })

  it('cuts on a word boundary rather than mid-word', () => {
    const context = passageContext([{ title: 'T', text: 'antidisestablishmentarianism rules' }], 20)
    expect(context).not.toContain('antidisestablishmentarianis ')
  })

  it('returns empty when nothing was retrieved', () => {
    expect(passageContext([])).toBe('')
    expect(passageContext([{ title: 'T', text: '   ' }])).toBe('')
  })
})

describe('isEchoOfQuestion()', () => {
  const asked = 'What did the trial find about oyster mortality?'

  it('catches the asked question wearing different grammar', () => {
    expect(isEchoOfQuestion('Which oyster mortality findings came out of the trial?', asked))
      .toBe(true)
  })

  it('keeps a follow-up that brings in something new', () => {
    expect(isEchoOfQuestion('How did water temperature affect mortality?', asked)).toBe(false)
  })

  it('treats a question with no topic words as an echo', () => {
    expect(isEchoOfQuestion('What about that?', asked)).toBe(true)
  })
})

describe('selectFollowUps()', () => {
  const context = 'Hatchery report: Spat survival rose to 78 per cent after the water ' +
    'temperature was held below 22 degrees through summer.'
  const asked = 'What did the trial find about oyster mortality?'
  const ok = {
    question: 'How did water temperature change spat survival?',
    evidence: 'Spat survival rose to 78 per cent after the water temperature was held below 22',
  }

  it('keeps a grounded, substantive follow-up', () => {
    expect(selectFollowUps([ok], context, asked)).toEqual([ok.question])
  })

  it('drops a follow-up the retrieved passages never answer', () => {
    // The failure this guards: a follow-up the assistant then refuses is worse
    // than no follow-up, because the portal itself put it in front of the reader.
    const bogus = {
      question: 'What did the minister say about the hatchery?',
      evidence: 'The minister welcomed the findings and promised further funding.',
    }
    expect(selectFollowUps([bogus], context, asked)).toEqual([])
  })

  it('drops the question that was just asked, reworded', () => {
    const echo = {
      question: 'Which oyster mortality findings came out of the trial?',
      evidence: ok.evidence,
    }
    expect(selectFollowUps([echo], context, asked)).toEqual([])
  })

  it('drops questions about the documents as objects', () => {
    const meta = { question: 'Who wrote this hatchery report?', evidence: ok.evidence }
    expect(selectFollowUps([meta], context, asked)).toEqual([])
  })

  it('drops thin evidence and questions that are not questions', () => {
    expect(selectFollowUps([{ question: ok.question, evidence: 'Yes.' }], context, asked))
      .toEqual([])
    expect(
      selectFollowUps(
        [{ question: 'Water temperature and spat survival', evidence: ok.evidence }],
        context,
        asked,
      ),
    ).toEqual([])
  })

  it('drops a follow-up too long to read as a chip', () => {
    const rambling = {
      question:
        'How did the water temperature being held below 22 degrees through summer change the ' +
        'observed spat survival rate in the hatchery?',
      evidence: ok.evidence,
    }
    expect(selectFollowUps([rambling], context, asked)).toEqual([])
  })

  it('de-duplicates rewordings of each other and caps at the requested count', () => {
    const twin = {
      question: 'How did holding water temperature change spat survival?',
      evidence: ok.evidence,
    }
    const other = {
      question: 'What summer conditions were the hatchery held to?',
      evidence: ok.evidence,
    }
    expect(selectFollowUps([ok, twin, other], context, asked, 3)).toEqual([
      ok.question,
      other.question,
    ])
  })

  it('returns [] when there is no retrieved text to test against', () => {
    // evidenceIsGrounded trusts the model when it has nothing to check; here an
    // untested follow-up is exactly the failure this module exists to avoid.
    expect(selectFollowUps([ok], '', asked)).toEqual([])
  })

  it('returns [] for a non-array payload', () => {
    expect(selectFollowUps(null, context, asked)).toEqual([])
  })
})
