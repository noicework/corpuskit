/**
 * A frozen copy of how the build at 756fed6 (the last release before document delete) parses a
 * portal's capacity ledger: `StoredCapacitySchema` and `awaitingMeasurementReadable`, copied
 * verbatim, and the parse `readCapacity` makes with them. That build refuses a ledger it cannot
 * parse, so a ledger written by any later build must still parse here, or rolling back would
 * refuse every add on the portal. Never edit this to follow the current schema.
 */
import { z } from 'zod'

const MINUTE = 60_000
const RESERVATION_TTL = 6 * 60 * MINUTE
/** Writes in flight at once for one portal; beyond this an add is refused as unavailable. */
const MAX_IN_FLIGHT = 1_000
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const ResourceIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/)
const TokenSchema = z.string().regex(/^[a-f0-9]{32}$/)

const RecentSchema = z.array(z.object({ at: Count, count: Count.positive() }).strict())
  .max(RESERVATION_TTL / MINUTE + 1)
/** A crawled link the ledger has not measured yet. */
const MeasuringSchema = z.object({
  /** When it was added. */
  at: Count,
  /** Provisional bytes held against a byte limit until it is measured. */
  reserved: Count,
  /** When a measurement was last tried; the least recently tried are tried first. */
  checked: Count.optional(),
  /**
   * When the reads of it began answering 404 without a break. A box that has not caught up with
   * a write answers 404 for moments; one that has answered 404 for `MEASURE_TIMEOUT` no longer
   * has the resource, which then holds nothing.
   */
  missingSince: Count.optional(),
  /**
   * Still unprocessed or unreadable `MEASURE_TIMEOUT` after it was added. It no longer counts as
   * in flight, but keeps its provisional bytes until it is measured or removed.
   */
  unsized: z.literal(true).optional(),
}).strict()
type Measuring = z.infer<typeof MeasuringSchema>
const StoredCapacitySchema = z.object({
  v: z.literal(1),
  /** Resource count the knowledge box last reported. */
  observed: Count,
  /**
   * Admitted adds whose write has not settled yet, with their source bytes. `measure` marks an
   * add whose size is known only once the platform has processed it, such as a crawled link:
   * its bytes are the provisional bytes it holds until then.
   */
  inflight: z.array(
    z.object({ token: TokenSchema, at: Count, bytes: Count, measure: z.literal(true).optional() })
      .strict(),
  ).max(MAX_IN_FLIGHT),
  /** Settled adds the reported count may not include yet, per minute. */
  added: RecentSchema,
  /** Deletions the reported count may still include, per minute. */
  removed: RecentSchema,
  /** Source bytes of each resource this portal added. */
  sized: z.record(ResourceIdSchema, Count),
  /** Resources in the knowledge box whose size the ledger does not know. */
  unsized: Count,
  /**
   * Resources this portal added whose size is measured once the platform has processed them.
   * Each holds its provisional bytes until then. Absent when empty.
   */
  measuring: z.record(ResourceIdSchema, MeasuringSchema).optional(),
}).strict()
type StoredCapacity = z.infer<typeof StoredCapacitySchema>

function awaitingMeasurementReadable(raw: unknown, provisional: number): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const record = { ...(raw as Record<string, unknown>) }
  if (Array.isArray(record.inflight)) {
    record.inflight = record.inflight.map((entry) =>
      entry && typeof entry === 'object' && (entry as { measure?: unknown }).measure === true &&
        (entry as { bytes?: unknown }).bytes === 0
        ? { ...entry, bytes: provisional }
        : entry
    )
  }
  if (!('measuring' in record)) return record
  const measuring = record.measuring
  const readable: Record<string, Measuring> = {}
  if (measuring && typeof measuring === 'object' && !Array.isArray(measuring)) {
    for (const [id, value] of Object.entries(measuring)) {
      if (!ResourceIdSchema.safeParse(id).success) continue
      const entry = MeasuringSchema.safeParse(value)
      const at = Count.safeParse(value)
      readable[id] = entry.success
        ? entry.data
        : { at: at.success ? at.data : 0, reserved: provisional }
    }
  }
  if (Object.keys(readable).length) record.measuring = readable
  else delete record.measuring
  return record
}

/** Parse a stored ledger exactly as 756fed6's `readCapacity` does, throwing where it throws. */
export function parseCapacityAt756fed6(raw: unknown, provisional = 10 * 1024 * 1024): unknown {
  const parsed = StoredCapacitySchema.safeParse(awaitingMeasurementReadable(raw, provisional))
  if (!parsed.success) throw new Error('Invalid persisted portal capacity')
  return parsed.data
}
