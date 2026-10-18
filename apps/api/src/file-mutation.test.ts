import { appendFileSync } from 'node:fs'
import { expect } from '@std/expect'
import { fileMutation } from './file-mutation.ts'
import { writeFileAtomic } from './persist.ts'

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
