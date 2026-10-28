import { expect } from '@std/expect'

const workflows = new URL('../../../.github/workflows/', import.meta.url)
const read = (name: string) => Deno.readTextFileSync(new URL(name, workflows))

function job(workflow: string, name: string): string {
  const content = workflow.split(`\n  ${name}:\n`)[1]
  if (!content) throw new Error(`Missing workflow job: ${name}`)
  return content.split(/\n {2}[\w-]+:\n/)[0]!
}

Deno.test('nothing deploys until every browser E2E shard passes', () => {
  const deploy = read('deploy.yml')
  expect(job(deploy, 'deploy-demo')).toContain('\n    needs: [gate, e2e]\n')
  expect(job(deploy, 'deploy')).toContain('\n    needs: [gate, deploy-demo]\n')
})

Deno.test('pull requests run the same browser E2E shards that gate a deploy', () => {
  const shardRun = (workflow: string) =>
    job(workflow, 'e2e').split('\n').filter((line) =>
      /^ +(shard: |SHARDS?: |ASTRAL_BIN_ARGS: |ignore=|deno task )/.test(line)
    )
  const pullRequest = shardRun(read('ci.yml'))
  expect(pullRequest).toEqual(shardRun(read('deploy.yml')))
  expect(pullRequest).toContain('          deno task test:e2e "--ignore=$ignore"')
  expect(pullRequest).toHaveLength(6)
})
