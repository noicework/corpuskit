import { expect } from '@std/expect'

const workflows = new URL('../../../.github/workflows/', import.meta.url)

function job(workflow: string, name: string): string {
  const content = workflow.split(`\n  ${name}:\n`)[1]
  if (!content) throw new Error(`Missing workflow job: ${name}`)
  return content.split(/\n {2}[\w-]+:\n/)[0]!
}

function assertDemoOnlyDeployment(workflow: string) {
  const production = job(workflow, 'deploy')
  const demo = job(workflow, 'deploy-demo')
  expect(production).toContain('needs: [gate, deploy-demo]')
  expect(production).not.toContain('persona-smoke.ts')
  expect(production).not.toContain('PERSONA_SMOKE_TENANTS')
  expect(workflow).not.toContain('vars.PERSONA_SMOKE_TENANTS')
  expect(workflow).not.toContain("'opax'")

  const smokeSteps = demo.split(/\n(?= {6}- )/).filter((step) => step.includes('persona-smoke.ts'))
  expect(smokeSteps).toHaveLength(2)
  for (const step of smokeSteps) {
    expect(step).toContain('BASE_URL: https://demo.corpuskit.org\n')
    expect(step).toContain('PERSONA_SMOKE_TENANTS: demo\n')
    expect(step).not.toContain('vars.')
    expect(step).toContain(
      'deno run --allow-net --allow-env apps/api/scripts/persona-smoke.ts --quick',
    )
  }
  expect(smokeSteps.some((step) => step.includes("steps.rollback.outcome == 'success'"))).toBe(true)
  expect(production).toContain('verify corpuskit "$RUNNER_TEMP/production-candidate.json"')
  expect(production).toContain('verify corpuskit "$RUNNER_TEMP/production-before.json"')
  expect(production).toContain('rollback corpuskit "$RUNNER_TEMP/production-before.json"')
  expect(production.match(/\$BASE_URL\/auth\/me/g)).toHaveLength(2)
  expect(production.match(/https:\/\/\$host\/api\/health/g)).toHaveLength(4)
}

Deno.test('release functional smoke, including recovery, is demo-only and gates production', () => {
  const workflow = Deno.readTextFileSync(new URL('deploy.yml', workflows))
  assertDemoOnlyDeployment(workflow)
  for (
    const broken of [
      workflow.replace('needs: [gate, deploy-demo]', 'needs: gate'),
      workflow.replace('BASE_URL: https://demo.corpuskit.org', 'BASE_URL: https://corpuskit.org'),
      workflow.replace('PERSONA_SMOKE_TENANTS: demo', 'PERSONA_SMOKE_TENANTS: opax'),
      workflow.replace(
        'PERSONA_SMOKE_TENANTS: demo',
        'PERSONA_SMOKE_TENANTS: ${{ vars.PERSONA_SMOKE_TENANTS }}',
      ),
    ]
  ) expect(() => assertDemoOnlyDeployment(broken)).toThrow()
})

Deno.test('scheduled and manually dispatched acceptance cannot use old production tenant overrides', () => {
  const workflow = Deno.readTextFileSync(new URL('acceptance.yml', workflows))
  expect(workflow).toContain('schedule:')
  expect(workflow).toContain('workflow_dispatch:')
  expect(workflow).toContain('ACCEPTANCE_TENANTS: demo\n')
  expect(workflow).toContain('ACCEPTANCE_BASE_URL: https://demo.corpuskit.org\n')
  expect(workflow).not.toContain('inputs:')
  expect(workflow).not.toContain('inputs.')
  expect(workflow).not.toContain('vars.ACCEPTANCE_')
  expect(workflow).not.toContain('opax')
  expect(workflow).toContain('apps/api/scripts/live-acceptance.ts')
})

Deno.test('new automatic functional smoke call sites require an explicit target-policy review', () => {
  const callers: string[] = []
  for (const entry of Deno.readDirSync(workflows)) {
    if (!entry.isFile || !/\.ya?ml$/.test(entry.name)) continue
    const workflow = Deno.readTextFileSync(new URL(entry.name, workflows))
    if (/persona-smoke\.ts|live-acceptance\.ts/.test(workflow)) callers.push(entry.name)
  }
  expect(callers.sort()).toEqual(['acceptance.yml', 'deploy.yml'])
})
