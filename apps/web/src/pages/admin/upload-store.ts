import type { RecentResource } from '@research-portal/core'
import type { AuthorityController } from '../../api/access-lifecycle.ts'
import { AdminAccessError, type AdminRequestAccess } from '../../api/break-glass.ts'
import { uploadAdminFile } from '../../api/client.ts'
import { MissingPermissionError } from '../../components/EmergencyAccess.tsx'
import { errorMessage } from './shared.ts'
import { applyProcessing, refuseFile, type UploadRow } from './upload-queue.ts'

/** Runs one upload with the access a caller chose: its own session, or one emergency request. */
export type UploadRunner = <T>(
  label: string,
  action: (access: AdminRequestAccess) => Promise<T>,
) => Promise<T | undefined>

/**
 * The uploads one person is making to one portal. It lives outside the page, so an upload in
 * flight outlives a re-check of access that confirms the same person (which redraws the page):
 * its row, progress and outcome are there when the page returns, and files still waiting go on.
 * It belongs to one identity and one authority controller; queues of anyone else are dropped as
 * soon as another identity asks for one. It never judges permission itself: the panel showing it
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
    this.#access = access
    void this.#pump()
    return () => {
      if (this.#access === access) this.#access = null
    }
  }

  /** Queue files; ones the portal would refuse fail at once with the reason. */
  add(files: File[], runner?: UploadRunner): UploadRow[] {
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
    if (!this.#files.has(key)) return
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
      // An answer withheld from changed authority is not this person's failure to report.
      if (!this.emergency && this.controller.context.identityKey !== this.identityKey) return
      this.#update(key, {
        status: 'failed',
        progress: null,
        error: errorMessage(err, 'The upload failed - please try again.'),
        retryable: true,
      })
    }
  }
}

const queues = new Map<string, UploadQueue>()

/**
 * The upload queue for the current identity on a portal, or null while no identity holds
 * ready authority. Queues belonging to anyone else, or to another controller, are dropped.
 */
export function uploadQueueFor(controller: AuthorityController, slug: string): UploadQueue | null {
  const identityKey = controller.context.identityKey
  if (controller.status !== 'ready' || !identityKey) return null
  for (const [key, queue] of queues) {
    if (queue.identityKey !== identityKey || queue.controller !== controller) queues.delete(key)
  }
  const key = JSON.stringify([identityKey, slug])
  let queue = queues.get(key)
  if (!queue) {
    queue = new UploadQueue(identityKey, slug, controller)
    queues.set(key, queue)
  }
  return queue
}
