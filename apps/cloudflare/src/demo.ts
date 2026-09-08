import { TenantConfigSchema } from '@research-portal/core'
import type { DurableTenantStore } from './state.ts'

/** The documentation collection is provisioned only in the isolated demo Worker. */
export const DEMO_TENANT = TenantConfigSchema.parse({
  slug: 'demo',
  hostname: 'demo.corpuskit.org',
  branding: {
    productName: 'CorpusKit',
    organisation: 'CorpusKit',
    tagline: 'Explore the documentation. See the platform at work.',
    colours: {
      primary: '#f2efe7',
      accent: '#155da6',
      heroFrom: '#f2efe7',
      heroTo: '#f2efe7',
    },
    paletteId: 'corpuskit',
    typography: 'archivo-source',
    shape: 'rounded',
    density: 'comfortable',
  },
  regionalDiscovery: false,
  searchPlaceholder: 'Ask about search, labels, knowledge graphs or cited answers…',
  topics: [
    { id: 'getting-started', label: 'Getting started' },
    { id: 'finding-answers', label: 'Finding answers' },
    { id: 'exploring-the-corpus', label: 'Exploring the collection' },
    { id: 'working-with-the-portal', label: 'Working with the portal' },
    { id: 'administration', label: 'Administration and ARAG' },
  ],
  suggestedQuestions: [
    { id: 'labels', text: 'How do labels and categories improve search and discovery?' },
    { id: 'citations', text: 'How can I check the sources and confidence of an answer?' },
    { id: 'graph', text: 'What does a knowledge graph add to document search?' },
    { id: 'ingestion', text: 'What happens when I add a document to a knowledge box?' },
    { id: 'models', text: 'How do I connect my own model through OpenRouter?' },
    { id: 'investigations', text: 'How can I build an investigation from cited evidence?' },
  ],
  entityTypes: [
    { id: 'product', label: 'Product', colour: '#155da6' },
    { id: 'capability', label: 'Capability', colour: '#5c5a53' },
    { id: 'concept', label: 'Concept', colour: '#0d467f' },
  ],
  relationTypes: ['provides', 'uses', 'supports', 'organises', 'evaluates'],
})

export function initialiseDemo(
  tenants: Pick<DurableTenantStore, 'get' | 'seed' | 'setDisabled'>,
  environment: string | undefined,
): void {
  if (environment !== 'demo' || tenants.get('demo')) return
  tenants.seed(DEMO_TENANT)
  tenants.setDisabled('marine', true)
  tenants.setDisabled('grains', true)
}
