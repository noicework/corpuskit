import { expect } from '@std/expect'
import {
  activeSnapshot,
  capture,
  captureCandidate,
  publishedVersion,
  rollback,
  type Run,
  validateSnapshot,
  verifyLive,
} from './release-safety.ts'

const account = 'a'.repeat(32)
const previousId = '00000000-0000-0000-0000-000000000001'
const candidateId = '00000000-0000-0000-0000-000000000002'
const previousVersion = '00000000-0000-0000-0000-000000000003'
const candidateVersion = '00000000-0000-0000-0000-000000000004'
const rollbackId = '00000000-0000-0000-0000-000000000005'
const previous = {
  id: previousId,
  created_on: '2026-09-09T00:00:00Z',
  versions: [{ version_id: previousVersion, percentage: 100 }],
}
const candidate = {
  id: candidateId,
  created_on: '2026-09-09T01:00:00Z',
  versions: [{ version_id: candidateVersion, percentage: 100 }],
}
const before = activeSnapshot('corpuskit', account, [previous])
const after = activeSnapshot('corpuskit', account, [previous, candidate])

Deno.test('publish output requires exactly one valid explicit version ID', () => {
  expect(publishedVersion(`Uploaded corpuskit\nCurrent Version ID: ${candidateVersion}\n`)).toBe(
    candidateVersion,
  )
  expect(publishedVersion(`\u001b[32mCurrent Version ID: ${candidateVersion}\u001b[0m\n`)).toBe(
    candidateVersion,
  )
  for (
    const output of [
      '',
      'Deploy complete',
      'Current Version ID: ',
      'Current Version ID: --help',
      `Current Version ID: ${candidateVersion}\nCurrent Version ID: ${candidateVersion}`,
      `Current Version ID: ${candidateVersion}\nCurrent Version ID: ${previousVersion}`,
      `Current Version ID: ${candidateVersion}; echo unsafe`,
    ]
  ) expect(() => publishedVersion(output)).toThrow()
})

Deno.test('candidate capture is bound to the version from this publish, not another active release', async () => {
  let calls = 0
  const run: Run = () => {
    calls++
    return Promise.resolve(JSON.stringify([previous, candidate]))
  }
  expect(
    await captureCandidate(
      'corpuskit',
      account,
      `Current Version ID: ${candidateVersion}`,
      run,
    ),
  ).toEqual(after)
  await expect(captureCandidate(
    'corpuskit',
    account,
    `Current Version ID: ${previousVersion}`,
    run,
  )).rejects.toThrow('Active version differs from this publish')
  expect(calls).toBe(2)
  await expect(captureCandidate('corpuskit', account, '', run)).rejects.toThrow()
  expect(calls).toBe(2)
})

Deno.test('capture selects newest deployment, not latest uploaded version or first list entry', async () => {
  const args: string[][] = []
  const snapshot = await capture('corpuskit-demo', account, (command) => {
    args.push(command)
    return Promise.resolve(JSON.stringify([previous, candidate]))
  })
  expect(snapshot.versionId).toBe(candidateVersion)
  expect(args).toEqual([[
    'deployments',
    'list',
    '--config',
    'wrangler.demo.jsonc',
    '--name',
    'corpuskit-demo',
    '--json',
  ]])
  expect(activeSnapshot('corpuskit', account, [candidate, previous])).toEqual(after)
})

Deno.test('capture fails closed for missing, malformed, ambiguous or split active deployments', () => {
  for (
    const data of [
      [],
      {},
      null,
      [{ ...previous, id: 'unsafe' }],
      [{ ...previous, created_on: 'invalid' }],
      [previous, previous],
      [{ ...previous, versions: [] }],
      [{ ...previous, versions: [{ version_id: previousVersion, percentage: 50 }] }],
      [{ ...previous, versions: [...previous.versions, ...candidate.versions] }],
    ]
  ) expect(() => activeSnapshot('corpuskit', account, data)).toThrow()
  expect(() => activeSnapshot('unrelated-worker', account, [previous])).toThrow()
  expect(() => activeSnapshot('corpuskit', '', [previous])).toThrow()
})

Deno.test('saved snapshots cannot cross Worker/account boundaries or inject command arguments', () => {
  expect(() => validateSnapshot('corpuskit-demo', account, before)).toThrow()
  expect(() => validateSnapshot('corpuskit', 'b'.repeat(32), before)).toThrow()
  expect(() => validateSnapshot('corpuskit', account, { ...before, versionId: '--help' })).toThrow()
})

Deno.test('rollback uses the exact previous version and confirms it without deleting state', async () => {
  const commands: string[][] = []
  const run: Run = (command) => {
    commands.push(command)
    if (commands.length === 1) return Promise.resolve(JSON.stringify([candidate]))
    if (commands.length === 2) return Promise.resolve('rolled back')
    return Promise.resolve(JSON.stringify([{
      ...previous,
      id: rollbackId,
      created_on: '2026-09-09T02:00:00Z',
    }]))
  }
  await rollback(before, after, run)
  expect(commands[1]).toEqual([
    'rollback',
    previousVersion,
    '--config',
    'wrangler.jsonc',
    '--name',
    'corpuskit',
    '--yes',
    '--message',
    'Automatic recovery: post-deploy verification failed',
  ])
  expect(commands.map((command) => command[0])).toEqual(['deployments', 'rollback', 'deployments'])
})

Deno.test('rollback refuses to overwrite a later deployment or cross Worker snapshots', async () => {
  let calls = 0
  const run: Run = () => {
    calls++
    return Promise.resolve(JSON.stringify([{ ...candidate, id: rollbackId }]))
  }
  await expect(rollback(before, after, run)).rejects.toThrow('Active deployment changed')
  expect(calls).toBe(1)
  await expect(rollback(before, { ...after, worker: 'corpuskit-demo' }, run)).rejects.toThrow()
  await expect(rollback(before, before, run)).rejects.toThrow('Candidate is not newer')
  expect(calls).toBe(1)
})

Deno.test('rollback failure and unconfirmed recovery remain failures', async () => {
  let calls = 0
  await expect(rollback(before, after, () => {
    if (++calls === 2) throw new Error('Cloudflare rejected rollback')
    return Promise.resolve(JSON.stringify([candidate]))
  })).rejects.toThrow('Cloudflare rejected rollback')
  calls = 0
  await expect(rollback(before, after, () => {
    calls++
    return Promise.resolve(JSON.stringify([candidate]))
  }, () => Promise.resolve())).rejects.toThrow('did not restore the exact previous version')
  expect(calls).toBe(8)
})

Deno.test('live verification retries stale edge versions and checks the exact Worker origin', async () => {
  const urls: string[] = []
  await verifyLive(before, (url) => {
    urls.push(String(url))
    return Promise.resolve(Response.json({
      ok: true,
      version: urls.length === 1 ? candidateVersion : previousVersion,
    }))
  }, () => Promise.resolve())
  expect(urls).toEqual(['https://corpuskit.org/api/health', 'https://corpuskit.org/api/health'])
  await verifyLive({ ...before, worker: 'corpuskit-demo' }, (url) => {
    expect(String(url)).toBe('https://demo.corpuskit.org/api/health')
    return Promise.resolve(Response.json({ ok: true, version: previousVersion }))
  })
})

Deno.test('live verification rejects healthy but wrong-version responses', async () => {
  let calls = 0
  await expect(verifyLive(before, () => {
    calls++
    return Promise.resolve(Response.json({ ok: true, version: candidateVersion }))
  }, () => Promise.resolve())).rejects.toThrow('exact expected Worker version')
  expect(calls).toBe(12)
})
