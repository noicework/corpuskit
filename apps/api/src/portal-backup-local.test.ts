import { expect } from '@std/expect'
import { Buffer } from 'node:buffer'
import { openLocalRbac } from './rbac-local.ts'
import { createAuditEvent } from './audit.ts'
import { localPortalBackup } from './portal-backup-local.ts'

Deno.test('local restore journal recovers interrupted file writes and preserves a committed receipt', () => {
  const directory = Deno.makeTempDirSync({ prefix: 'restore-journal-' })
  const { database, rbac } = openLocalRbac({ DATA_DIR: directory })
  const path = `${directory}/fixture.json`, journal = `${directory}/portal-restore-journal.json`
  const receipt = 'restore-' + 'a'.repeat(64)
  let reloads = 0
  try {
    const pending = () =>
      Deno.writeTextFileSync(
        journal,
        JSON.stringify({
          receipt,
          before: [{ path, bytes: Buffer.from('original bytes').toString('base64') }],
        }),
      )
    Deno.writeTextFileSync(path, 'interrupted bytes')
    pending()
    localPortalBackup(directory, database, {}, () => reloads++)
    expect(Deno.readTextFileSync(path)).toBe('original bytes')
    expect(() => Deno.statSync(journal)).toThrow()
    rbac.audit.append(
      createAuditEvent(
        {
          requestId: receipt,
          actor: { kind: 'system' },
          action: 'portal.import.bundle',
          scope: { kind: 'portal', slug: 'fixture' },
          target: { kind: 'portal', id: 'fixture' },
          outcome: 'success',
          detail: { bundleId: 'a'.repeat(64) },
        },
        Date.now,
        () => receipt,
      ),
    )
    Deno.writeTextFileSync(path, 'committed bytes')
    pending()
    localPortalBackup(directory, database, {}, () => reloads++)
    expect(Deno.readTextFileSync(path)).toBe('committed bytes')
    expect(() => Deno.statSync(journal)).toThrow()
    expect(reloads).toBe(2)
  } finally {
    database.close()
    Deno.removeSync(directory, { recursive: true })
  }
})
