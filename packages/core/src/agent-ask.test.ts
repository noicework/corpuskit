import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  type AgentAskEvent,
  AgentAskEventSchema,
  AgentAskRequestSchema,
  FederationSettingsSchema,
  offersAgentAsk,
  participatesInFederation,
  TenantConfigSchema,
} from './index.ts'

const portal = {
  slug: 'a',
  branding: {
    productName: 'Research',
    organisation: 'Research',
    tagline: 'Research',
    colours: { primary: '#123456', accent: '#123456', heroFrom: '#123456', heroTo: '#123456' },
  },
  searchPlaceholder: 'Search',
  topics: [],
  suggestedQuestions: [],
  entityTypes: [],
  relationTypes: [],
}

const source = { id: 'drv-one', label: 'Source one' }
const chunk = { id: 'res-1/f/file/0-120', title: 'A report', text: 'A passage.' }

describe('AgentAskEventSchema', () => {
  it('accepts one of every event in the contract', () => {
    const events: AgentAskEvent[] = [
      { type: 'agent-start', mode: 'agent', sources: [source] },
      { type: 'agent-start', mode: 'agent', sources: [] },
      {
        type: 'agent-step',
        id: 'context/c1',
        module: 'basic_ask',
        title: 'Searching',
        status: 'started',
      },
      {
        type: 'agent-step',
        id: 'context/c1',
        module: 'basic_ask',
        title: 'Searching',
        status: 'completed',
        elapsedMs: 18_500,
        reason: 'One lookup per source.',
      },
      {
        type: 'agent-step',
        id: 'context/c2',
        module: 'basic_ask',
        title: 'Searching',
        status: 'failed',
      },
      {
        type: 'agent-sources',
        stepId: 'context/c1',
        source,
        question: 'A narrower question?',
        chunks: [chunk, { ...chunk, id: 'res-2/f/file/0-80', url: 'https://example.org/r.pdf' }],
      },
      { type: 'agent-sources', stepId: 'context/c1', source, chunks: [] },
      {
        type: 'agent-start',
        mode: 'orchestrated',
        sources: [{ id: 'portal-a', label: 'Portal A', portal: 'portal-a' }],
      },
      {
        type: 'sources-failed',
        sources: [
          {
            id: 'portal-b',
            label: 'Portal B',
            portal: 'portal-b',
            kind: 'hosted',
            reason: 'timeout',
          },
          {
            id: 'peer:p',
            label: 'Partner',
            kind: 'peer',
            transport: 'mcp',
            reason: 'unauthorised',
          },
        ],
      },
      {
        type: 'agent-sources',
        stepId: 'source/portal-a',
        source: { id: 'portal-a', label: 'Portal A', portal: 'portal-a' },
        chunks: [{ ...chunk, id: 'portal-a/res-1', resourceId: 'res-1' }],
      },
      { type: 'reasoning', text: 'Thinking.', last: false },
      { type: 'delta', text: 'The answer [block-AA].' },
      {
        type: 'citation',
        marker: 'block-AA',
        sourceId: 'drv-one',
        chunkId: chunk.id,
        title: 'A report',
        url: 'http://example.org/r.pdf',
      },
      { type: 'done', elapsedMs: 89_800 },
      { type: 'error', code: 'timeout', message: 'Too slow.', retryable: true },
      { type: 'error', code: 'upstream', message: 'Failed.', retryable: true },
      { type: 'error', code: 'cancelled', message: 'Stopped.', retryable: false },
      { type: 'error', code: 'not_configured', message: 'No agent.', retryable: false },
    ]
    for (const event of events) expect(AgentAskEventSchema.parse(event)).toEqual(event)
  })

  it('refuses links a page must not render, and malformed events', () => {
    const bad = [
      {
        type: 'agent-sources',
        stepId: 's',
        source,
        chunks: [{ ...chunk, url: 'javascript:alert(1)' }],
      },
      {
        type: 'citation',
        marker: 'm',
        sourceId: 's',
        chunkId: 'c',
        title: '',
        url: 'data:text/html,x',
      },
      { type: 'agent-step', id: 's', module: 'm', title: 't', status: 'running' },
      { type: 'agent-step', id: '', module: 'm', title: 't', status: 'started' },
      { type: 'done', elapsedMs: -1 },
      { type: 'done', elapsedMs: 1.5 },
      { type: 'error', code: 'unknown', message: 'x', retryable: true },
      { type: 'reasoning', text: 'x' },
      { type: 'sources', resources: [] },
      { type: 'agent-start', sources: [] },
      { type: 'agent-start', mode: 'other', sources: [] },
      { type: 'sources-failed', sources: [] },
      { type: 'sources-failed', sources: [{ ...source, reason: 'slow' }] },
    ]
    for (const event of bad) expect(AgentAskEventSchema.safeParse(event).success).toBe(false)
  })
})

describe('AgentAskRequestSchema', () => {
  it('takes a question and optional prior turns, nothing else', () => {
    expect(AgentAskRequestSchema.parse({ query: '  Why?  ' })).toEqual({ query: 'Why?' })
    const context = [{ author: 'USER' as const, text: 'Earlier' }, {
      author: 'AGENT' as const,
      text: 'Reply',
    }]
    expect(AgentAskRequestSchema.parse({ query: 'Why?', context }).context).toEqual(context)
    for (
      const body of [
        {},
        { query: '' },
        { query: '   ' },
        { query: 'x'.repeat(2001) },
        { query: 'Why?', extra: true },
        { query: 'Why?', context: [{ author: 'SYSTEM', text: 'x' }] },
        {
          query: 'Why?',
          context: Array.from({ length: 25 }, () => ({ author: 'USER', text: 'x' })),
        },
      ]
    ) expect(AgentAskRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false)
  })
})

describe('the agentAsk portal setting', () => {
  it('is opt-in: only true offers agent ask', () => {
    const config = portal
    expect(offersAgentAsk(TenantConfigSchema.parse(config))).toBe(false)
    expect(offersAgentAsk(TenantConfigSchema.parse({ ...config, agentAsk: false }))).toBe(false)
    expect(offersAgentAsk(TenantConfigSchema.parse({ ...config, agentAsk: true }))).toBe(true)
    for (const agentAsk of ['true', 1, null]) {
      expect(TenantConfigSchema.safeParse({ ...config, agentAsk }).success).toBe(false)
    }
  })
})

describe('FederationSettingsSchema', () => {
  const peer = { id: 'partner', label: 'Partner', kind: 'arag-kb', zone: 'zone-1', kbId: 'box-1' }
  it('takes participation and peers addressed by zone and box only', () => {
    expect(FederationSettingsSchema.parse({ participates: false })).toEqual({ participates: false })
    expect(FederationSettingsSchema.parse({ peers: [{ ...peer, linkOrigins: true }] }).peers)
      .toEqual([{ ...peer, linkOrigins: true }])
    for (
      const bad of [
        { peers: [{ ...peer, zone: 'a.b' }] },
        { peers: [{ ...peer, zone: '127.0.0.1' }] },
        { peers: [{ ...peer, kbId: '../x' }] },
        { peers: [{ ...peer, kind: 'corpuskit-mcp' }] },
        { peers: [{ ...peer, token: 'secret' }] },
        { peers: [{ ...peer, mcpUrl: 'https://evil.example' }] },
        { peers: [peer, peer] },
        { participates: 'no' },
      ]
    ) expect(FederationSettingsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
  })

  it('treats a portal as taking part unless it opts out', () => {
    expect(participatesInFederation({})).toBe(true)
    expect(participatesInFederation({ federation: {} })).toBe(true)
    expect(participatesInFederation({ federation: { participates: false } })).toBe(false)
  })
})
