/**
 * One-off upgrade for seeded demo boxes: add a 'kind' labelset (report /
 * briefing / review, from the seed manifest) alongside 'topic', and re-label
 * every seeded resource with both classifications. Gives the knowledge graph
 * a second dimension. Idempotent. Usage: deno task enrich
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { envBindings, KbClient } from '@research-portal/retrieval'
import { loadRootEnv } from '../src/load-env.ts'

loadRootEnv()

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

interface ManifestEntry {
  tenant: string
  file: string
  topic: string
  type: string
}

const manifest = JSON.parse(
  readFileSync(resolve(ROOT, 'content/seed/manifest.json'), 'utf8'),
) as ManifestEntry[]

const bindings = envBindings(process.env)

for (const slug of [...new Set(manifest.map((m) => m.tenant))]) {
  const binding = bindings[slug]
  if (!binding) {
    console.log(`skip ${slug}: no env binding`)
    continue
  }
  console.log(`\nEnriching ${slug} (${binding.kbId})`)
  const client = new KbClient(binding)
  const kinds = [...new Set(manifest.filter((m) => m.tenant === slug).map((m) => m.type))]
  try {
    await client.postJson('/labelset/kind', {
      title: 'Kind',
      color: '#8a6d3b',
      multiple: false,
      kind: ['RESOURCES'],
      labels: kinds.map((title) => ({ title })),
    })
    console.log(`  labelset 'kind' configured (${kinds.join(', ')})`)
  } catch (err) {
    console.warn(`  labelset create warning: ${err instanceof Error ? err.message : err}`)
  }
  for (const entry of manifest.filter((m) => m.tenant === slug)) {
    const resourceSlug = (entry.file.split('/').at(-1) ?? '').replace(/\.md$/, '')
    try {
      await client.patchJson(`/slug/${resourceSlug}`, {
        usermetadata: {
          classifications: [
            { labelset: 'topic', label: entry.topic },
            { labelset: 'kind', label: entry.type },
          ],
        },
      })
      console.log(`  ~ ${resourceSlug} labelled topic=${entry.topic} kind=${entry.type}`)
    } catch (err) {
      console.error(`  ! ${resourceSlug}: ${err instanceof Error ? err.message : err}`)
    }
  }
}
console.log('\nEnrichment complete.')
