import type { RecentResource } from '@research-portal/core'
import type { AuthorityController } from '../../api/access-lifecycle.ts'
import { AdminAccessError, type AdminRequestAccess } from '../../api/break-glass.ts'
import { uploadAdminFile } from '../../api/client.ts'
import { MissingPermissionError } from '../../components/EmergencyAccess.tsx'
import { errorMessage } from './shared.ts'
import { applyProcessing, refuseFile, type UploadRow } from './upload-queue.ts'

/** An unfinished upload whose person no longer holds access here: its file was not kept. */
export const UPLOAD_INTERRUPTED = 'Upload interrupted, choose the file again.'
/** An upload whose answer was withheld when access changed: the file may have arrived. */
export const UPLOAD_UNCONFIRMED =
  'We could not confirm this upload. Check Recent additions before trying again.'

/** Runs one upload with the access a caller chose: its own session, or one emergency request. */
export type UploadRunner = <T>(
  label: string,
  action: (access: AdminRequestAccess) => Promise<T>,
) => Promise<T | undefined>

/**
 * The uploads one person is making to one portal. It lives outside the page, so an upload in
 * flight outlives a re-check of access that confirms the same person (which redraws the page):
 * its row, progress and outcome are there when the page returns, and files still waiting go on.
 * It belongs to one identity and one authority controller. The moment the controller holds access
 * for anyone else, or for nobody, the queue is closed: nothing in it is sent or kept, and its
 * person chooses the files again. It never judges permission itself: the panel showing it
 * attaches its own permission-checked access, and nothing is sent while access is being checked,
 * while no panel is attached, or for anyone but its identity.
 */
export class UploadQueue {
  #rows: UploadRow[] = []
  #files = new Map<string, File>()
  #runners = new Map<string, UploadRunner>()
  #pending: string[] = []
  #listeners = new Set<() => void>()
  #running = false
  #percent = new Map<string, number>()
  #access: AdminRequestAccess | null = null
  #closed = false

  constructor(
    readonly identityKey: string,
    readonly slug: string,
    readonly controller: AuthorityController,
    private readonly upload: typeof uploadAdminFile = uploadAdminFile,
    /**
     * An emergency queue sends each file only through the confirmation its runner asks for, so
     * it neither needs nor checks the session's own identity or permission.
     */
    private readonly emergency = false,
  ) {}

  subscribe = (listener: () => void): () => void => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  snapshot = (): UploadRow[] => this.#rows

  #set(rows: UploadRow[]) {
    if (rows === this.#rows) return
    this.#rows = rows
    for (const listener of [...this.#listeners]) listener()
  }

  #update(key: string, patch: Partial<UploadRow>) {
    this.#set(this.#rows.map((row) => row.key === key ? { ...row, ...patch } : row))
  }

  /** Whether the queue was closed because its identity no longer holds access here. */
  get closed(): boolean {
    return this.#closed
  }

  /**
   * Close the queue: another identity, or none, now holds access here. Files still waiting are
   * dropped unsent, an upload in flight was already cut off by the change, and every unfinished
   * row says it was interrupted. Nothing it held can be sent or tried again.
   */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#pending = []
    this.#files.clear()
    this.#runners.clear()
    this.#percent.clear()
    this.#access = null
    this.#set(
      this.#rows.map((row) =>
        row.status === 'queued' || row.status === 'uploading'
          ? {
            ...row,
            status: 'failed',
            progress: null,
            error: UPLOAD_INTERRUPTED,
            retryable: false,
          }
          : row
      ),
    )
  }

  /** This identity still holds the controller's ready authority. */
  #current(): boolean {
    return this.controller.status === 'ready' &&
      this.controller.context.identityKey === this.identityKey
  }

  /**
   * Send through the attached panel's access, which checks the permission on every request.
   * Returns the detach for when that panel goes.
   */
  attach(access: AdminRequestAccess): () => void {
    if (this.#closed) return () => {}
    this.#access = access
    void this.#pump()
    return () => {
      if (this.#access === access) this.#access = null
    }
  }

  /** Queue files; ones the portal would refuse fail at once with the reason. */
  add(files: File[], runner?: UploadRunner): UploadRow[] {
    if (this.#closed) return []
    const added = files.map((file): UploadRow => {
      const refusal = refuseFile(file)
      return {
        key: crypto.randomUUID(),
        name: file.name,
        size: file.size,
        status: refusal ? 'failed' : 'queued',
        progress: null,
        ...(refusal ? { error: refusal, retryable: false } : {}),
      }
    })
    added.forEach((row, index) => {
      if (row.status !== 'queued') return
      this.#files.set(row.key, files[index]!)
      if (runner) this.#runners.set(row.key, runner)
      this.#pending.push(row.key)
    })
    this.#set([...this.#rows, ...added])
    void this.#pump()
    return added
  }

  /** Whether a failed row still has its file, so it can be tried again. */
  canRetry(key: string): boolean {
    return this.#files.has(key)
  }

  retry(key: string, runner?: UploadRunner): void {
    if (this.#closed || !this.#files.has(key)) return
    if (runner) this.#runners.set(key, runner)
    this.#update(key, { status: 'queued', progress: null, error: undefined })
    this.#pending.push(key)
    void this.#pump()
  }

  clearFinished(): void {
    const keep = this.#rows.filter((row) => row.status !== 'ready' && row.status !== 'failed')
    const kept = new Set(keep.map((row) => row.key))
    for (const key of [...this.#files.keys()]) {
      if (!kept.has(key)) {
        this.#files.delete(key)
        this.#runners.delete(key)
      }
    }
    this.#set(keep)
  }

  /** Apply the knowledge box's view of its newest resources to uploads still processing. */
  applyProcessing(recent: RecentResource[], now: number): void {
    this.#set(applyProcessing(this.#rows, recent, now))
  }

  async #pump(): Promise<void> {
    if (this.#running) return
    this.#running = true
    try {
      // One file at a time keeps each row's progress true and the knowledge box's queue calm.
      while (this.#pending.length) {
        // Nothing starts while access is being checked, or for anyone who may not add content.
        await this.controller.settled()
        if (this.#closed) return
        // Waiting files resume when a panel for this identity attaches again.
        if (!this.emergency && (!this.#current() || !this.#access)) return
        await this.#uploadOne(this.#pending.shift()!)
      }
    } finally {
      this.#running = false
    }
  }

  async #uploadOne(key: string): Promise<void> {
    const file = this.#files.get(key)
    if (!file) return
    this.#update(key, { status: 'uploading', progress: 0, error: undefined })
    this.#percent.delete(key)
    const runner = this.#runners.get(key)
    const send = (access: AdminRequestAccess) =>
      this.upload(this.slug, access, file, {}, (loaded, total) => {
        const size = total ?? file.size
        if (!size) return
        const percent = Math.min(100, Math.floor((loaded / size) * 100))
        // One update per whole percent, not per progress event.
        if (this.#percent.get(key) === percent) return
        this.#percent.set(key, percent)
        this.#update(key, { progress: percent / 100 })
      })
    // The attached panel's access, checked when the upload is sent rather than when queued.
    const access = this.#access
    try {
      if (!runner && !access) throw new MissingPermissionError()
      const result = runner ? await runner(`Upload ${file.name}`, send) : await send(access!)
      if (this.#closed) return
      if (result === undefined) {
        this.#update(key, {
          status: 'failed',
          progress: null,
          error: 'The upload was cancelled.',
          retryable: true,
        })
        return
      }
      if (!result || typeof result.id !== 'string' || !result.id) throw new AdminAccessError()
      this.#update(key, {
        status: 'processing',
        progress: null,
        resourceId: result.id,
        uploadedAt: Date.now(),
      })
      this.#runners.delete(key)
    } catch (err) {
      // Closing already settled the row for someone who no longer holds access here.
      if (this.#closed) return
      // Access changed while the file was on its way, and its answer was withheld: the file may
      // have arrived, so trying again blindly could add it twice.
      const withheld = err instanceof Error && err.name === 'AbortError'
      this.#update(key, {
        status: 'failed',
        progress: null,
        error: withheld
          ? UPLOAD_UNCONFIRMED
          : errorMessage(err, 'The upload failed - please try again.'),
        retryable: true,
      })
    }
  }
}

const queues = new Map<string, UploadQueue>()
const watched = new WeakSet<AuthorityController>()

/**
 * Close every queue of `controller` whose identity no longer holds its ready authority. This runs
 * whenever the controller changes, so a queue is closed the moment someone else (or nobody) is
 * signed in here, not when a panel is next opened.
 */
function closeOthers(controller: AuthorityController): void {
  if (controller.status !== 'ready') return
  for (const [key, queue] of queues) {
    if (queue.controller === controller && queue.identityKey !== controller.context.identityKey) {
      queues.delete(key)
      queue.close()
    }
  }
}

/**
 * The upload queue for the current identity on a portal, or null while no identity holds ready
 * authority. The store watches the controller from the first call and closes a queue as soon as
 * its identity loses access; queues of a replaced controller are closed too. `upload` is the
 * transport a new queue sends with.
 */
export function uploadQueueFor(
  controller: AuthorityController,
  slug: string,
  upload: typeof uploadAdminFile = uploadAdminFile,
): UploadQueue | null {
  for (const [key, queue] of queues) {
    if (queue.controller !== controller) {
      queues.delete(key)
      queue.close()
    }
  }
  if (!watched.has(controller)) {
    watched.add(controller)
    controller.subscribe(() => closeOthers(controller))
  }
  closeOthers(controller)
  const identityKey = controller.context.identityKey
  if (controller.status !== 'ready' || !identityKey) return null
  const key = JSON.stringify([identityKey, slug])
  let queue = queues.get(key)
  if (!queue) {
    queue = new UploadQueue(identityKey, slug, controller, upload)
    queues.set(key, queue)
  }
  return queue
}
