import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { DEFAULT_VISUAL_RULE, methodFromStrategy, strategyBody } from './index.ts'

describe('extraction method shapes', () => {
  it('maps a table-aware method to ai_tables and a visual one to vllm_config', () => {
    expect(strategyBody({ name: 'table-aware', kind: 'tables', model: 'm' })).toEqual({
      name: 'table-aware',
      ai_tables: { llm: { generative_model: 'm' } },
    })
    const visual = strategyBody({ name: 'visual', kind: 'visual' }) as {
      vllm_config: { rules: string[] }
    }
    expect(visual.vllm_config.rules).toEqual([DEFAULT_VISUAL_RULE])
  })

  it('reads the platform strategy back into the portal vocabulary', () => {
    expect(
      methodFromStrategy('id1', {
        name: 'table-aware',
        ai_tables: { llm: { generative_model: 'g' } },
      }),
    )
      .toEqual({ id: 'id1', name: 'table-aware', kind: 'tables', model: 'g' })
    expect(methodFromStrategy('id2', { name: 'v', vllm_config: { rules: ['r'], llm: {} } }))
      .toEqual({ id: 'id2', name: 'v', kind: 'visual', rules: ['r'] })
    expect(methodFromStrategy('id3', { name: 'plain' }).kind).toBe('default')
  })
})
