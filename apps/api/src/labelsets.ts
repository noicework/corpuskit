import type { TenantConfig } from '@research-portal/core'
import type { AgentConfig, AragProvider } from '@research-portal/retrieval'

/**
 * Label-set editing with one rule: saving a set re-instantiates every
 * labeller agent that carries it. The knowledge box keeps a per-label
 * definition in the label's `text`, but a labeller carries its own copy of
 * labels and descriptions in its task configuration and never reads the
 * labelset at run time - so the editor owns both writes, in this order:
 * labelset first, then delete-and-start each carrying agent.
 *
 * `planLabelsetRebuild` is the pure part (agent configs + saved labelset ->
 * the delete/start calls); `applyLabelsetUpdate` performs it.
 */

export interface LabelDefinition {
  title: string
  /** The definition; empty when the label has none. */
  text: string
}

export interface SavedLabelset {
  id: string
  title: string
  multiple: boolean
  labels: LabelDefinition[]
}

/** The `start` half of a rebuild step - what `startAgent` needs. */
export interface RebuildStart {
  task: string
  title: string
  operations: unknown[]
  model: string
  filter?: unknown
  on?: number
}

export interface RebuildStep {
  /** The agent to remove before starting its replacement. */
  deleteId: string
  /** The agent as it was, so a failed replacement can be restored by hand. */
  previous: AgentConfig
  start: RebuildStart
}

export type LabelOperation = {
  label: { ident?: string; labels?: unknown[]; multiple?: boolean; [key: string]: unknown }
}

/** A `{ label: { ident, ... } }` operation whose `ident` is `labelsetId`. */
export function isLabelOpFor(op: unknown, labelsetId: string): op is LabelOperation {
  if (!op || typeof op !== 'object' || !('label' in op)) return false
  const label = (op as { label?: unknown }).label
  return Boolean(
    label && typeof label === 'object' &&
      (label as { ident?: unknown }).ident === labelsetId,
  )
}

/** Whether an agent carries the labelset - one of its operations labels into it. */
export function carriesLabelset(agent: AgentConfig, labelsetId: string): boolean {
  return agent.operations.some((op) => isLabelOpFor(op, labelsetId))
}

/**
 * Given the configured agents and the labelset as saved, the delete/start
 * pairs that bring the carrying labellers up to date. Only agents with a
 * `label` operation on this set are included; in each, only that operation's
 * `labels` (title -> `label`, text -> `description`) and `multiple` change.
 * Every other operation, the model, the filter, the name and the trigger are
 * copied unchanged. The replacement always applies to NEW resources only.
 */
export function planLabelsetRebuild(agents: AgentConfig[], labelset: SavedLabelset): RebuildStep[] {
  const labels = labelset.labels.map((l) => ({ label: l.title, description: l.text }))
  const steps: RebuildStep[] = []
  for (const agent of agents) {
    if (!carriesLabelset(agent, labelset.id)) continue
    const operations = agent.operations.map((op) =>
      isLabelOpFor(op, labelset.id)
        ? { label: { ...op.label, labels, multiple: labelset.multiple } }
        : op
    )
    const start: RebuildStart = {
      task: agent.task,
      title: agent.title,
      operations,
      model: agent.model,
    }
    if (agent.filter !== undefined) start.filter = agent.filter
    if (agent.on !== undefined) start.on = agent.on
    steps.push({ deleteId: agent.id, previous: agent, start })
  }
  return steps
}

/**
 * Raised when a carrying agent was deleted but its replacement could not be
 * started. Carries the deleted agent's full previous configuration so it can
 * be restored by hand - never swallowed.
 */
export class AgentRestartError extends Error {
  constructor(readonly previous: AgentConfig, override readonly cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    super(
      `The labelset was saved and agent "${previous.title}" (${previous.id}) was removed, ` +
        `but its replacement could not be started: ${reason}. ` +
        'Re-create it by hand from the previous configuration.',
    )
    this.name = 'AgentRestartError'
  }
}

export interface LabelsetUpdateResult {
  id: string
  /** The labellers re-instantiated, in order; empty when none carried the set. */
  agents: { previousId: string; newTitle: string }[]
}

/**
 * Write the labelset, then re-instantiate each carrying labeller (delete,
 * then start the replacement with `apply: NEW`). A start failure surfaces as
 * `AgentRestartError` with the previous configuration attached.
 */
export async function applyLabelsetUpdate(
  management: AragProvider,
  config: TenantConfig,
  labelset: SavedLabelset,
): Promise<LabelsetUpdateResult> {
  await management.updateLabelset(config, labelset)
  const steps = planLabelsetRebuild(await management.agentConfigs(config), labelset)
  const agents: LabelsetUpdateResult['agents'] = []
  for (const step of steps) {
    await management.deleteAgent(config, step.deleteId)
    try {
      await management.startAgent(config, { ...step.start, applyExisting: false })
    } catch (err) {
      throw new AgentRestartError(step.previous, err)
    }
    agents.push({ previousId: step.deleteId, newTitle: step.start.title })
  }
  return { id: labelset.id, agents }
}
