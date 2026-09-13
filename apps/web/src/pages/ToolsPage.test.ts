import { expect } from '@std/expect'
import { mcpConfigSnippet } from './ToolsPage.tsx'

Deno.test('public MCP configuration is keyless and restricted configuration uses only a placeholder', () => {
  expect(
    JSON.parse(mcpConfigSnippet('https://portal.example/api/t/marine/mcp', 'marine'))
      .mcpServers['marine-knowledge'],
  ).toEqual({ type: 'streamable-http', url: 'https://portal.example/api/t/marine/mcp' })
  const restricted = mcpConfigSnippet(
    'https://portal.example/api/t/grains/mcp',
    'grains',
    'YOUR_KEY',
  )
  expect(restricted).toContain('Bearer YOUR_KEY')
  expect(restricted).not.toContain('ck_')
})
Deno.test('Tools has one canonical permitted manager link and exact extraction permission', async () => {
  const source = await Deno.readTextFile(new URL('./ToolsPage.tsx', import.meta.url))
  expect(source).toContain("access.can('keys.manage', scope)")
  expect(source).toContain("access.can('content.write', scope)")
  expect(source).toContain('manage?tab=access#access-keys')
  expect(source).not.toMatch(/\bfetch\s*\(|useQuery|useMutation|createCredential|revokeCredential/)
  expect(source).toContain('without a key')
})
Deno.test('all rendered frontend surfaces reject coarse administrator authority', async () => {
  const scan = async (path: string): Promise<void> => {
    for await (const entry of Deno.readDir(path)) {
      const file = `${path}/${entry.name}`
      if (entry.isDirectory) await scan(file)
      else if (
        /\.(tsx?|jsx?)$/.test(file) && !file.includes('.test.') &&
        file !== 'apps/web/src/api/auth.ts'
      ) {
        expect({
          file,
          usesCoarseAuthority: /\bisAdmin\b|\bcoarseAdminEligible\b/.test(
            await Deno.readTextFile(file),
          ),
        }).toEqual({ file, usesCoarseAuthority: false })
      }
    }
  }
  await scan('apps/web/src')
})
