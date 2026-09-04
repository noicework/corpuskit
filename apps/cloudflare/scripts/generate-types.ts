await Deno.mkdir('.wrangler', { recursive: true })
const temporary = '.wrangler/worker-configuration.generated.d.ts'
try {
  const result = await new Deno.Command('npx', {
    args: [
      '-y',
      'wrangler@4.127.1',
      'types',
      temporary,
      '--config',
      'wrangler.jsonc',
      '--include-runtime=false',
    ],
    stdin: 'null',
    stdout: 'inherit',
    stderr: 'inherit',
  }).spawn().status
  if (!result.success) throw new Error(`Wrangler exited with status ${result.code}`)

  const generated = await Deno.readTextFile(temporary)
  // With a custom Deno bundle already present Wrangler emits a type-only import
  // of the generated JS without its extension. Keep Env generation stable both
  // before and after a local build; the runtime shim owns the namespace surface.
  const stable = generated.split('\n').map((line) => {
    if (/^\s*PORTAL: DurableObjectNamespace/.test(line)) {
      return '\tPORTAL: DurableObjectNamespace /* PortalDurableObject */;'
    }
    if (/^\s*mainModule: typeof import/.test(line)) return '\t\tmainModule: unknown;'
    return line
  }).join('\n')
  await Deno.writeTextFile('worker-configuration.d.ts', stable)
} finally {
  await Deno.remove(temporary).catch(() => {})
}
