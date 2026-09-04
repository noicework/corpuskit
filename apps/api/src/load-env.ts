import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import process from 'node:process'

/**
 * Load the repo-root .env into process.env (existing values win). Kept
 * dependency-free; called once at server and script startup.
 */
export function loadRootEnv(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  let raw: string
  try {
    raw = readFileSync(resolve(root, '.env'), 'utf8')
  } catch {
    return
  }
  for (const line of raw.split('\n')) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!match) continue
    const [, key, value] = match
    if (key && value !== undefined && process.env[key] === undefined) {
      process.env[key] = value.replace(/^"(.*)"$/, '$1')
    }
  }
}
