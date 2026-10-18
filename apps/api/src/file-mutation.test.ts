import { appendFileSync } from 'node:fs'
import { expect } from '@std/expect'
import { fileMutation } from './file-mutation.ts'

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
