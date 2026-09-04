import { expect } from '@std/expect'
import { mcpConfigSnippet } from './ToolsPage.tsx'

Deno.test('MCP config includes the tenant endpoint and bearer authorisation', () => {
  const snippet = mcpConfigSnippet(
    'https://portal.example/api/t/marine/mcp',
    'marine',
    'ck_mcp_example_secret',
  )
  const parsed = JSON.parse(snippet)

  expect(parsed.mcpServers['marine-knowledge']).toEqual({
    type: 'streamable-http',
    url: 'https://portal.example/api/t/marine/mcp',
    headers: { Authorization: 'Bearer ck_mcp_example_secret' },
  })
})

Deno.test('MCP config defaults to a non-secret key placeholder', () => {
  const snippet = mcpConfigSnippet('https://portal.example/api/t/grains/mcp', 'grains')
  expect(snippet).toContain('Bearer YOUR_KEY')
  expect(snippet).not.toContain('ck_mcp_')
})

Deno.test('Tools page gates key controls and deliberately contains opaque strings on phones', async () => {
  const source = await Deno.readTextFile(new URL('./ToolsPage.tsx', import.meta.url))

  expect(source).toContain('const isAdmin = auth?.user?.isAdmin === true')
  expect(source).toContain('enabled: isAdmin')
  expect(source).toContain('!isAdmin')
  expect(source).toContain('break-all')
  expect(source).toContain('[overflow-wrap:anywhere]')
  expect(source).toContain('rounded-[var(--rp-radius-input)]')
})
