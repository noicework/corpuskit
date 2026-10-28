import { expect } from '@std/expect'

const root = new URL('../../../', import.meta.url)
const workflows = new URL('.github/workflows/', root)
const read = (name: string) => Deno.readTextFileSync(new URL(name, workflows))

function job(workflow: string, name: string): string {
  const content = workflow.split(`\n  ${name}:\n`)[1]
  if (!content) throw new Error(`Missing workflow job: ${name}`)
  return content.split(/\n {2}[\w-]+:\n/)[0]!
}

/** The lines of a sharded job that decide what it runs and over how many shards. */
const shardRun = (workflow: string, name: string) =>
  job(workflow, name).split('\n').filter((line) =>
    /^ +(shard: |SHARDS?: |ASTRAL_BIN_ARGS: |ignore=|deno task )/.test(line)
  )

Deno.test('nothing deploys until every unit and browser E2E shard passes', () => {
  const deploy = read('deploy.yml')
  expect(job(deploy, 'deploy-demo')).toContain('\n    needs: [gate, unit, e2e]\n')
  expect(job(deploy, 'deploy')).toContain('\n    needs: [gate, deploy-demo]\n')
})

Deno.test('pull requests run the same shards that gate a deploy', () => {
  for (const name of ['unit', 'e2e']) {
    expect(shardRun(read('ci.yml'), name)).toEqual(shardRun(read('deploy.yml'), name))
  }
  expect(shardRun(read('ci.yml'), 'unit')).toHaveLength(5)
  expect(shardRun(read('ci.yml'), 'e2e')).toHaveLength(6)
})

Deno.test('the gate jobs together run the whole of deno task check', () => {
  const tasks = JSON.parse(Deno.readTextFileSync(new URL('deno.json', root))).tasks
  expect(tasks.check).toBe('deno task check:static && deno task test')
  for (const workflow of [read('ci.yml'), read('deploy.yml')]) {
    expect(job(workflow, 'gate')).toContain('\n        run: deno task check:static\n')
    expect(shardRun(workflow, 'unit')).toContain('          deno task test "--ignore=$ignore"')
    expect(shardRun(workflow, 'e2e')).toContain('          deno task test:e2e "--ignore=$ignore"')
  }
})
