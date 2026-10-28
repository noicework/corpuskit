export * from './compose.ts'
export type {
  AgentAskOptions,
  ComposePassage,
  ExportResource,
  ListResourcesOptions,
  RetrievalProvider,
  SourceContext,
} from './provider.ts'
export { AgentAskError } from './provider.ts'
export {
  PEER_MCP_METHODS,
  PEER_MCP_TOOLS,
  PEER_PASSAGES,
  PEER_PATHS,
  peerEndpoint,
  PeerError,
  type PeerFailure,
  PeerMcpSession,
  type PeerPassage,
  searchPeer,
} from './providers/arag/peers.ts'
export {
  AgentStreamNormaliser,
  type AgentStreamOptions,
  normaliseAgentStream,
} from './providers/arag/agent-stream.ts'
export { AragProvider, KnowledgeBoxNotConnectedError } from './providers/arag/index.ts'
export type { AgentConfig } from './providers/arag/index.ts'
export {
  ALLOWED_KB_HOSTS,
  AragApiError,
  KbClient,
  ndjson,
  parseKbUrl,
  regionalBase,
} from './providers/arag/client.ts'
export type { KbBinding } from './providers/arag/client.ts'
export { createProviderFromEnv, envBindings, labBindings } from './env.ts'
export {
  baselineMerchandising,
  extractPageSummary,
  fallbackTitle,
  findPageSummaryFieldId,
  isPageSummaryFieldId,
  looksLikeFilenameTitle,
  type Merchandised,
  overlayEnrichment,
  sourceNameFor,
} from './merchandise.ts'
export { PROMPT_VARIANTS, type PromptVariant, variantPreamble } from './prompts.ts'
export {
  intentConfigurationName,
  intentFilterExpression,
  intentSearchConfigs,
  intentStrategies,
  isGeneratedField,
  shapeSourcesForIntent,
} from './providers/arag/index.ts'
export {
  DEFAULT_VISUAL_RULE,
  looksLikeReferenceChunk,
  methodFromStrategy,
  strategyBody,
} from './providers/arag/index.ts'
