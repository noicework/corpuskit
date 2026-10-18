import { expect } from '@std/expect'
import { basename, dirname, posix } from 'node:path'
import { DEVELOPER_DOCS } from '../../../packages/core/src/docs.ts'

const root = new URL('../../../', import.meta.url)
const dockerfile = Deno.readTextFileSync(new URL('Dockerfile', root))
const imports: Record<string, string> = JSON.parse(
  Deno.readTextFileSync(new URL('deno.json', root)),
).imports

interface Copy {
  source: string
  target: string
  directory: boolean
}

/** The current Dockerfile uses simple context COPY instructions; fail on unfamiliar syntax. */
function copies(text: string): Copy[] {
  return [...text.matchAll(/^COPY\s+(.+)$/gm)].flatMap((match) => {
    const fields = match[1]!.trim().split(/\s+/)
    expect(fields.length).toBeGreaterThanOrEqual(2)
    expect(fields.some((field) => /[\[\]"*]|^--/.test(field))).toBe(false)
    const destination = fields.pop()!
    return fields.map((source) => {
      const stat = Deno.statSync(new URL(source, root))
      return {
        source: posix.normalize(source),
        target: posix.normalize(
          !stat.isDirectory && destination.endsWith('/')
            ? posix.join(destination, basename(source))
            : destination,
        ),
        directory: stat.isDirectory,
      }
    })
  })
}

function covered(path: string, list: Copy[]): boolean {
  return list.some((copy) => {
    if (path === copy.source) return copy.target === path
    return copy.directory && path.startsWith(`${copy.source}/`) &&
      posix.join(copy.target, path.slice(copy.source.length + 1)) === path
  })
}

/** Follow literal local imports and re-exports, including import-map aliases and dynamic imports. */
function runtimeModules(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen
  seen.add(entry)
  const text = Deno.readTextFileSync(new URL(entry, root))
  for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)['"]([^'"]+)['"]/g)) {
    const specifier = match[1]!
    const mapped = imports[specifier]
    const local = mapped?.startsWith('.')
      ? posix.normalize(mapped)
      : specifier.startsWith('.')
      ? posix.join(dirname(entry), specifier)
      : undefined
    if (local) runtimeModules(local, seen)
  }
  return seen
}

Deno.test('Docker COPY sources exist and include the published guides and build metadata', () => {
  const list = copies(dockerfile)
  expect(list.length).toBeGreaterThan(0)
  for (
    const path of [
      'deno.json',
      'CHANGELOG.md',
      ...DEVELOPER_DOCS.map((doc) => `docs/${doc.file}`),
    ]
  ) {
    expect(covered(path, list), path).toBe(true)
  }
  expect(() => copies('COPY missing-build-input ./')).toThrow(Deno.errors.NotFound)
})

Deno.test('Docker COPY destinations cover every local Deno runtime import transitively', () => {
  const list = copies(dockerfile)
  const modules = [...runtimeModules('apps/api/src/server.ts')]
  expect(modules.length).toBeGreaterThan(100)
  expect(modules.filter((path) => !covered(path, list))).toEqual([])
  // Prove the check catches a missing transitive import tree, without starting Docker in CI.
  const withoutPackages = list.filter((copy) => copy.source !== 'packages')
  expect(modules.filter((path) => !covered(path, withoutPackages)).length).toBeGreaterThan(0)
  const movedApps = list.map((copy) =>
    copy.source === 'apps' ? { ...copy, target: 'wrong-directory' } : copy
  )
  expect(covered('apps/api/src/server.ts', movedApps)).toBe(false)
})
