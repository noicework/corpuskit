import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { ScoredResource } from '@research-portal/core'
import {
  blockPlainText,
  blocksWithinBudget,
  buildRelatedQuery,
  looksLikeSystemResource,
  parseDocBlocks,
  selectRecommendations,
  selectViewerVariant,
} from './resource-view.ts'

function scored(id: string, title: string): ScoredResource {
  return {
    id,
    title,
    summary: `${title} summary`,
    type: 'document',
    topicIds: [],
    keyFacts: [],
    relevance: 0.5,
    citedCount: 0,
  }
}

describe('selectViewerVariant', () => {
  it('maps each content kind to its viewer', () => {
    expect(selectViewerVariant('pdf')).toBe('pdf')
    expect(selectViewerVariant('video')).toBe('video')
    expect(selectViewerVariant('audio')).toBe('audio')
    expect(selectViewerVariant('image')).toBe('image')
    expect(selectViewerVariant('office')).toBe('office')
    expect(selectViewerVariant('web')).toBe('web')
  })

  it('reads text and file resources as the structured document reader', () => {
    expect(selectViewerVariant('text')).toBe('document')
    expect(selectViewerVariant('file')).toBe('document')
  })
})

describe('buildRelatedQuery', () => {
  it('joins title and summary into one collapsed query', () => {
    expect(buildRelatedQuery('Subsoil acidity', 'Deep lime lifts pH within three seasons.'))
      .toBe('Subsoil acidity. Deep lime lifts pH within three seasons.')
  })

  it('does not repeat the summary when it merely echoes the title', () => {
    expect(buildRelatedQuery('Bycatch reduction', 'bycatch reduction')).toBe('Bycatch reduction')
  })

  it('collapses whitespace and caps length', () => {
    const long = 'x'.repeat(500)
    expect(buildRelatedQuery('  a\n  b  ', undefined)).toBe('a b')
    expect(buildRelatedQuery(long).length).toBe(400)
  })
})

describe('looksLikeSystemResource', () => {
  it('rejects dotfiles and log/temp artefacts', () => {
    expect(looksLikeSystemResource('.uploaded.log')).toBe(true)
    expect(looksLikeSystemResource('.DS_Store')).toBe(true)
    expect(looksLikeSystemResource('ingest.log')).toBe(true)
    expect(looksLikeSystemResource('scratch.tmp')).toBe(true)
    expect(looksLikeSystemResource('')).toBe(true)
  })

  it('keeps genuine document titles', () => {
    expect(looksLikeSystemResource('Managing Subsoil Acidity')).toBe(false)
    expect(looksLikeSystemResource('2005-024-DLD')).toBe(false)
  })
})

describe('selectRecommendations', () => {
  it('excludes the current resource, junk files and duplicates, and caps the list', () => {
    const results = [
      scored('self', 'This document'),
      scored('a', 'A real neighbour'),
      scored('.uploaded.log', '.uploaded.log'),
      scored('a', 'A real neighbour'), // duplicate id
      scored('b', 'Another neighbour'),
      scored('c', 'Third neighbour'),
    ]
    const recs = selectRecommendations(results, 'self', 2)
    expect(recs.map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('preserves the incoming relevance order', () => {
    const recs = selectRecommendations([scored('a', 'A'), scored('b', 'B')], 'self')
    expect(recs.map((r) => r.id)).toEqual(['a', 'b'])
  })
})

describe('parseDocBlocks', () => {
  it('parses authored markdown into headings, paragraphs and lists with sequential indices', () => {
    const body = [
      '# Managing Subsoil Acidity',
      '',
      '## Executive summary',
      '',
      'This project quantified yield losses across',
      'cropping soils and trialled deep-banded lime.',
      '',
      '- Deep lime lifted pH from 4.4 to 5.1',
      '- Returned 2.3:1 on investment',
    ].join('\n')
    const blocks = parseDocBlocks(body)
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'heading', 'paragraph', 'list'])
    expect(blocks.map((b) => b.index)).toEqual([0, 1, 2, 3])
    // Soft-wrapped paragraph lines are joined into one block.
    expect((blocks[2] as { text: string }).text).toBe(
      'This project quantified yield losses across cropping soils and trialled deep-banded lime.',
    )
    const list = blocks[3]
    if (!list || list.kind !== 'list') throw new Error('expected list')
    expect(list.ordered).toBe(false)
    expect(list.items).toEqual([
      { text: 'Deep lime lifted pH from 4.4 to 5.1', children: [] },
      { text: 'Returned 2.3:1 on investment', children: [] },
    ])
  })

  it('folds soft-wrapped, indented continuation lines into one ordered-list item', () => {
    const body = [
      'Recommendations',
      '',
      '1. Growers on acidic soils should consider deep-banded lime rather',
      '   than relying on surface application to correct constraints.',
      '2. A gypsum-lime blend offers a faster initial response and may',
      '   suit near-term improvement.',
    ].join('\n')
    const blocks = parseDocBlocks(body)
    // One heading/paragraph plus a single list block - not four fragments.
    const list = blocks.find((b) => b.kind === 'list')
    if (!list || list.kind !== 'list') throw new Error('expected one list block')
    expect(list.ordered).toBe(true)
    expect(list.items).toEqual([
      {
        text:
          'Growers on acidic soils should consider deep-banded lime rather than relying on surface application to correct constraints.',
        children: [],
      },
      {
        text:
          'A gypsum-lime blend offers a faster initial response and may suit near-term improvement.',
        children: [],
      },
    ])
  })

  it('keeps a loose list (blank line between items) as one block', () => {
    const body = ['- first item', '', '- second item', '', '- third item'].join('\n')
    const blocks = parseDocBlocks(body)
    expect(blocks.length).toBe(1)
    const list = blocks[0]
    if (!list || list.kind !== 'list') throw new Error('expected list')
    expect(list.items.map((item) => item.text)).toEqual([
      'first item',
      'second item',
      'third item',
    ])
  })

  it('parses a streamed-answer block: intro line, star bullets and indented sub-bullets', () => {
    // The exact shape a live /ask answer arrives in - single newlines between
    // bullets, `*` markers, and four-space-indented sub-bullets.
    const body = [
      'More specifically:',
      '*   **Shortcut methods**: These provide direct recommendations. There are two options:',
      '    *   Developing MPs applicable to a basket of species.',
      '    *   Developing "canned" MSE/MP systems.',
      '*   **Risk Assessments**: For very data-limited fisheries.',
      '',
      'Ultimately, the goal is a defensible stock assessment.',
    ].join('\n')
    const blocks = parseDocBlocks(body)
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'list', 'paragraph'])
    const list = blocks[1]
    if (!list || list.kind !== 'list') throw new Error('expected list')
    expect(list.ordered).toBe(false)
    expect(list.items).toEqual([
      {
        text: '**Shortcut methods**: These provide direct recommendations. There are two options:',
        children: [
          'Developing MPs applicable to a basket of species.',
          'Developing "canned" MSE/MP systems.',
        ],
      },
      { text: '**Risk Assessments**: For very data-limited fisheries.', children: [] },
    ])
  })

  it('folds an indented continuation line into the sub-bullet it wraps from', () => {
    const body = [
      '* parent item',
      '    * a sub-bullet that wraps',
      '      onto the next line',
      '* second parent',
    ].join('\n')
    const blocks = parseDocBlocks(body)
    const list = blocks[0]
    if (!list || list.kind !== 'list') throw new Error('expected list')
    expect(list.items).toEqual([
      { text: 'parent item', children: ['a sub-bullet that wraps onto the next line'] },
      { text: 'second parent', children: [] },
    ])
  })

  it('parses a pipe table', () => {
    const body = ['| Depth | pH |', '| --- | --- |', '| 0-10cm | 5.2 |', '| 20-30cm | 4.4 |'].join(
      '\n',
    )
    const blocks = parseDocBlocks(body)
    expect(blocks.length).toBe(1)
    const table = blocks[0]
    if (!table || table.kind !== 'table') throw new Error('expected table')
    expect(table.headers).toEqual(['Depth', 'pH'])
    expect(table.rows).toEqual([['0-10cm', '5.2'], ['20-30cm', '4.4']])
  })

  it('treats each line of flattened extracted text (no blank lines) as its own block', () => {
    const body = 'Title line \n Executive summary \n This project quantified losses'
    const blocks = parseDocBlocks(body)
    expect(blocks.length).toBe(3)
    expect(blocks.every((b) => b.kind === 'paragraph')).toBe(true)
  })

  it('returns nothing for empty input', () => {
    expect(parseDocBlocks('')).toEqual([])
    expect(parseDocBlocks('   \n  ')).toEqual([])
  })
})

describe('blocksWithinBudget', () => {
  it('admits leading blocks until the character budget is exceeded', () => {
    expect(blocksWithinBudget([100, 100, 100, 100], 250)).toBe(2)
  })

  it('admits every block when the document fits the budget', () => {
    expect(blocksWithinBudget([100, 100], 40_000)).toBe(2)
    expect(blocksWithinBudget([], 40_000)).toBe(0)
  })

  it('always admits at least the first block, even one over budget', () => {
    expect(blocksWithinBudget([90_000, 100], 40_000)).toBe(1)
  })
})

describe('blockPlainText', () => {
  it('flattens list and table blocks for matching', () => {
    expect(
      blockPlainText({
        kind: 'list',
        ordered: false,
        items: [{ text: 'one', children: ['sub'] }, { text: 'two', children: [] }],
        index: 0,
      }),
    ).toBe('one sub two')
    expect(
      blockPlainText({ kind: 'table', headers: ['a', 'b'], rows: [['1', '2']], index: 0 }),
    ).toBe('a b 1 2')
    expect(blockPlainText({ kind: 'paragraph', text: 'hello', index: 0 })).toBe('hello')
  })
})
