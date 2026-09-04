import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { TenantConfig } from '@research-portal/core'
import { AragProvider, DEFAULT_DA_AGENT_MODEL } from './index.ts'

const TENANT = { slug: 'marine' } as TenantConfig
const resolveBinding = () => undefined

describe('AragProvider augmentation model', () => {
  it('defaults bulk DA work to the cheap extraction tier', async () => {
    const provider = new AragProvider({ resolveBinding, augmentationModel: '  ' })

    expect(await provider.augmentationModel(TENANT)).toBe(DEFAULT_DA_AGENT_MODEL)
    expect(DEFAULT_DA_AGENT_MODEL).toBe('gemini-2.5-flash-lite')
  })

  it('accepts a provider-level model override', async () => {
    const provider = new AragProvider({
      resolveBinding,
      augmentationModel: 'configured-cheap-model',
    })

    expect(await provider.augmentationModel(TENANT)).toBe('configured-cheap-model')
  })

  it('accepts the ARAG_DA_AGENT_MODEL environment knob', async () => {
    const previous = Deno.env.get('ARAG_DA_AGENT_MODEL')
    Deno.env.set('ARAG_DA_AGENT_MODEL', 'environment-cheap-model')
    try {
      const provider = new AragProvider({ resolveBinding })
      expect(await provider.augmentationModel(TENANT)).toBe('environment-cheap-model')
    } finally {
      if (previous === undefined) Deno.env.delete('ARAG_DA_AGENT_MODEL')
      else Deno.env.set('ARAG_DA_AGENT_MODEL', previous)
    }
  })
})
