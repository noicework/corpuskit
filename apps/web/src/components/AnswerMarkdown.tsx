import type { ReactNode } from 'react'
import { normaliseAnswerBullets } from '../lib/answer-text.ts'
import { type DocBlock, parseDocBlocks } from '../lib/resource-view.ts'

/**
 * The one block-level renderer for streamed AI answers. Parses the answer
 * text with `parseDocBlocks` (the same tested parser the document reader
 * uses), so an answer renders every shape the model actually writes -
 * `*`/`-`/numbered lists, indented sub-bullets, an intro line followed by
 * bullets in the same block, headings, quotes, code and pipe tables - rather
 * than collapsing them into paragraphs with literal markers.
 *
 * Inline treatment stays with the caller: each surface passes its own
 * `renderInline` (bold only, or bold plus linked citation markers), so the
 * assistant, search answers and docs help all share this block logic while
 * keeping their own citation behaviour.
 */
export interface AnswerMarkdownProps {
  text: string
  /** Renders one plain-text run (bold, citation markers). `keyPrefix` is stable per run. */
  renderInline: (text: string, keyPrefix: string) => ReactNode
  /** Classes for body runs (paragraphs, list items) - each surface keeps its own colour/size. */
  bodyClassName?: string
}

function ListBlock(
  { block, bodyClassName, renderInline, blockKey }: {
    block: Extract<DocBlock, { kind: 'list' }>
    bodyClassName: string
    renderInline: AnswerMarkdownProps['renderInline']
    blockKey: string
  },
): ReactNode {
  const ListTag = block.ordered ? 'ol' : 'ul'
  const markerClass = block.ordered ? 'list-decimal' : 'list-disc'
  return (
    <ListTag className={`${markerClass} space-y-1 pl-5 marker:text-ink-3`}>
      {block.items.map((item, itemIndex) => (
        <li key={itemIndex} className={bodyClassName}>
          {renderInline(item.text, `${blockKey}-li${itemIndex}`)}
          {item.children.length > 0
            ? (
              <ul className='mt-1 list-[circle] space-y-1 pl-5 marker:text-ink-3'>
                {item.children.map((child, childIndex) => (
                  <li key={childIndex} className={bodyClassName}>
                    {renderInline(child, `${blockKey}-li${itemIndex}-c${childIndex}`)}
                  </li>
                ))}
              </ul>
            )
            : null}
        </li>
      ))}
    </ListTag>
  )
}

export function AnswerMarkdown({
  text,
  renderInline,
  bodyClassName = 'text-sm leading-relaxed text-ink-2',
}: AnswerMarkdownProps): ReactNode {
  const blocks = parseDocBlocks(normaliseAnswerBullets(text))
  return (
    <div className='space-y-3'>
      {blocks.map((block, index) => {
        const key = `b${index}`
        switch (block.kind) {
          case 'heading': {
            // An answer sits below the page's own headings, so every model
            // heading renders at one visual level - h3 for the usual `###`,
            // h4 beneath it - keeping the document outline sensible.
            const Tag = block.level <= 3 ? 'h3' : 'h4'
            return (
              <Tag key={index} className='pt-1 text-sm font-semibold text-ink'>
                {renderInline(block.text, key)}
              </Tag>
            )
          }
          case 'list':
            return (
              <ListBlock
                key={index}
                block={block}
                bodyClassName={bodyClassName}
                renderInline={renderInline}
                blockKey={key}
              />
            )
          case 'quote':
            return (
              <blockquote
                key={index}
                className={`border-l-2 border-line pl-3 italic ${bodyClassName}`}
              >
                {renderInline(block.text, key)}
              </blockquote>
            )
          case 'code':
            return (
              <pre
                key={index}
                className='overflow-x-auto rounded-[var(--rp-radius)] bg-surface-2 p-3 text-xs leading-relaxed text-ink-2'
              >
                <code>{block.text}</code>
              </pre>
            )
          case 'table':
            return (
              <div key={index} className='overflow-x-auto'>
                <table className='w-full border-collapse text-sm'>
                  <thead>
                    <tr>
                      {block.headers.map((header, i) => (
                        <th
                          key={i}
                          className='border-b border-line px-3 py-2 text-left font-semibold text-ink'
                        >
                          {renderInline(header, `${key}-th${i}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, c) => (
                          <td
                            key={c}
                            className='border-b border-line px-3 py-2 align-top text-ink-2'
                          >
                            {renderInline(cell, `${key}-td${r}-${c}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          default:
            return (
              <p key={index} className={bodyClassName}>
                {renderInline(block.text, key)}
              </p>
            )
        }
      })}
    </div>
  )
}
