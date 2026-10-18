import { expect } from '@std/expect'
import { readJsonSafe, writeAssetAtomic, writeFileAtomic } from './persist.ts'
import { SuggestionStore } from './interrogate.ts'
import { ownedMutation } from './stores.ts'

Deno.test('atomic writer replaces JSON and binary bytes and cleans up after rename failure', () => {
  const directory = Deno.makeTempDirSync()
  try {
    const path = `${directory}/file`
    writeFileAtomic(path, 'previous')
    writeFileAtomic(path, new Uint8Array([0, 255, 10]))
    expect([...Deno.readFileSync(path)]).toEqual([0, 255, 10])
    Deno.mkdirSync(`${directory}/blocked`)
    expect(() => writeFileAtomic(`${directory}/blocked`, 'replacement')).toThrow()
    expect([...Deno.readDirSync(directory)].map((file) => file.name).sort()).toEqual([
      'blocked',
      'file',
    ])
  } finally {
    Deno.removeSync(directory, { recursive: true })
  }
})

Deno.test('branding replacement commits before retiring another format; rollback preserves exact bytes', () => {
  const directory = Deno.makeTempDirSync()
  try {
    const base = `${directory}/logo`
    writeAssetAtomic(base, 'png', ['png', 'jpg'], new Uint8Array([1, 2]))
    writeAssetAtomic(base, 'jpg', ['png', 'jpg'], new Uint8Array([3, 4]))
    expect([...Deno.readFileSync(`${base}.jpg`)]).toEqual([3, 4])
    expect(() => Deno.statSync(`${base}.png`)).toThrow()
    // A failed completion exercises the production ownedMutation rollback path.
    expect(() =>
      ownedMutation([{ path: `${base}.jpg`, value: { changed: true } }], {
        database: { transactionSync: (run) => run() },
        complete: () => {
          throw new Error('completion failed')
        },
      })
    ).toThrow('completion failed')
    expect([...Deno.readFileSync(`${base}.jpg`)]).toEqual([3, 4])
  } finally {
    Deno.removeSync(directory, { recursive: true })
  }
})

Deno.test('suggestion decisions persist atomically and corrupt JSON is reported and quarantined', () => {
  const directory = Deno.makeTempDirSync()
  const errors: unknown[][] = []
  const original = console.error
  console.error = (...args) => {
    errors.push(args)
  }
  try {
    const store = new SuggestionStore(directory)
    store.replacePending('portal', [{
      id: 'one',
      kind: 'entity-type',
      title: 'Example',
      detail: 'Example',
      status: 'pending',
      createdAt: new Date(0).toISOString(),
    }])
    store.setStatus('portal', 'one', 'implemented')
    expect(new SuggestionStore(directory).list('portal')[0]?.status).toBe('implemented')
    expect([...Deno.readDirSync(`${directory}/suggestions`)].length).toBe(1)
    Deno.writeTextFileSync(`${directory}/corrupt.json`, '{')
    expect(readJsonSafe(`${directory}/corrupt.json`, [])).toEqual([])
    expect(errors.length).toBe(2)
    expect([...Deno.readDirSync(directory)].some((file) => file.name.includes('.corrupt-'))).toBe(
      true,
    )
  } finally {
    console.error = original
    Deno.removeSync(directory, { recursive: true })
  }
})
