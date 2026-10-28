import { appendFileSync } from 'node:fs'
import { expect } from '@std/expect'
import { fileMutation } from './file-mutation.ts'
import { writeFileAtomic } from './persist.ts'
import { AuditWriteError } from './audit.ts'
import { ownedMutation } from './stores.ts'

Deno.test('failed restores log basename and code while preserving later paths, cache and audit failure', async (t) => {
  for (const adapter of ['file', 'owned']) {
    for (const failure of ['audit', 'commit']) {
      await t.step(`${adapter}, ${failure} failure`, () => {
        const directory = Deno.makeTempDirSync()
        const first = `${directory}/first.json`
        const blocked = `${directory}/blocked.json`
        const second = `${directory}/second.json`
        const original = new Uint8Array([0, 255, 10, 83])
        let cache = 'original'
        const breakRestore = () => {
          for (const path of [first, blocked]) {
            Deno.removeSync(path)
            Deno.mkdirSync(path)
          }
        }
        const boundary = {
          database: {
            transactionSync: <T>(work: () => T): T => {
              const result = work()
              if (failure === 'commit') {
                breakRestore()
                throw new Error('commit failed')
              }
              return result
            },
          },
          complete: () => {
            if (failure === 'audit') {
              breakRestore()
              throw new AuditWriteError()
            }
          },
        }
        const logs: string[] = []
        const report = console.error
        console.error = (line) => {
          logs.push(String(line))
        }
        try {
          for (const path of [first, blocked, second]) Deno.writeFileSync(path, original)
          expect(() => {
            if (adapter === 'file') {
              fileMutation([first, blocked, second], boundary, () => {
                for (const path of [first, blocked, second]) writeFileAtomic(path, 'changed')
                cache = 'changed'
              }, () => {
                cache = 'original'
              })
            } else {
              // ownedMutation restores in reverse order; the blocked files still precede second.
              ownedMutation([
                { path: second, value: 'changed' },
                { path: blocked, value: 'changed' },
                { path: first, value: 'changed' },
              ], boundary)
            }
          }).toThrow(AuditWriteError)
          expect(Deno.statSync(first).isDirectory).toBe(true)
          expect(Deno.statSync(blocked).isDirectory).toBe(true)
          expect(Deno.readFileSync(second)).toEqual(original)
          expect(cache).toBe('original')
          expect(logs.map((line) => JSON.parse(line))).toEqual(
            ['first.json', 'blocked.json'].map((file) => ({
              event: 'storage.restore_failed',
              file,
              code: expect.stringMatching(/^(EISDIR|EPERM|EACCES)$/),
            })),
          )
          for (const line of logs) {
            expect(line).not.toContain(directory)
            expect(line).not.toContain('changed')
          }
        } finally {
          console.error = report
          Deno.removeSync(directory, { recursive: true })
        }
      })
    }
  }
})

Deno.test('append checkpoints restore exact byte lengths after a partial append or audit failure', async (t) => {
  for (const existing of [undefined, '', 'A fish 🐟\npartial trailing row']) {
    for (const failure of ['work', 'audit']) {
      await t.step(
        `${
          existing === undefined ? 'missing' : existing.length ? 'populated' : 'empty'
        } log, ${failure} failure`,
        () => {
          const directory = Deno.makeTempDirSync()
          const path = `${directory}/log.jsonl`
          try {
            const before = existing === undefined ? undefined : new TextEncoder().encode(existing)
            if (before !== undefined) Deno.writeFileSync(path, before)
            expect(() =>
              fileMutation(
                [path],
                {
                  database: { transactionSync: (work) => work() },
                  complete: () => {
                    throw new Error('audit failed')
                  },
                },
                () => {
                  appendFileSync(path, 'appended 🐟\n')
                  if (failure === 'work') throw new Error('append interrupted')
                },
                undefined,
                'append',
              )
            ).toThrow(failure === 'work' ? 'append interrupted' : 'audit failed')
            if (before === undefined) {
              expect(() => Deno.statSync(path)).toThrow(Deno.errors.NotFound)
            } else expect(Deno.readFileSync(path)).toEqual(before)
          } finally {
            Deno.removeSync(directory, { recursive: true })
          }
        },
      )
    }
  }
})

Deno.test('replacement rollback restores exact bytes with atomic 0600 files after work, audit and commit failures', async (t) => {
  for (const failure of ['work', 'audit', 'commit']) {
    await t.step(failure, () => {
      const directory = Deno.makeTempDirSync()
      const path = `${directory}/record.json`
      const shadow = `${directory}/observed-replacement`
      const created = `${directory}/created.json`
      const original = new Uint8Array([0, 255, 10, 83])
      const replacement = new Uint8Array([12, 34, 56])
      let restoredCache = false
      try {
        Deno.writeFileSync(path, original)
        expect(() =>
          fileMutation(
            [path, created],
            {
              database: {
                transactionSync: (work) => {
                  const result = work()
                  if (failure === 'commit') throw new Error('commit failed')
                  return result
                },
              },
              complete: () => {
                if (failure === 'audit') throw new Error('audit failed')
              },
            },
            () => {
              writeFileAtomic(path, replacement)
              writeFileAtomic(created, replacement)
              if (Deno.build.os !== 'windows') Deno.chmodSync(path, 0o644)
              // An observer holding the replaced inode must never see a partial rollback write.
              Deno.linkSync(path, shadow)
              if (failure === 'work') throw new Error('work failed')
            },
            () => {
              restoredCache = true
            },
          )
        ).toThrow()
        expect(Deno.readFileSync(path)).toEqual(original)
        expect(Deno.readFileSync(shadow)).toEqual(replacement)
        expect(() => Deno.statSync(created)).toThrow(Deno.errors.NotFound)
        expect(restoredCache).toBe(true)
        if (Deno.build.os !== 'windows') expect(Deno.statSync(path).mode! & 0o777).toBe(0o600)
        expect([...Deno.readDirSync(directory)].some((entry) => entry.name.includes('.tmp-')))
          .toBe(false)
      } finally {
        Deno.removeSync(directory, { recursive: true })
      }
    })
  }
})
