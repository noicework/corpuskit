import { expect } from '@std/expect'
import { missingPortalMessages } from './locale-messages.ts'

/** Audit explicit literal calls. Dynamic labels and unwrapped copy need the screen inventory too. */
function literalUiKeys(source: string): string[] {
  const keys: string[] = []
  const calls = /\bui\(\s*/g
  let call: RegExpExecArray | null
  while ((call = calls.exec(source))) {
    let index = call.index + call[0].length
    const quote = source[index++]
    if (quote !== "'" && quote !== '"') continue
    let key = ''
    while (index < source.length) {
      const char = source[index++]!
      if (char === quote) {
        keys.push(key)
        break
      }
      if (char !== '\\') key += char
      else {
        const escaped = source[index++]!
        key += escaped === 'n' ? '\n' : escaped === 'r' ? '\r' : escaped === 't' ? '\t' : escaped
      }
    }
  }
  return keys
}

Deno.test('catalog audit recognises escaped literal messages and ignores dynamic authored values', () => {
  expect(literalUiKeys("ui('Save'); locale.ui(\"Name\"); ui('It\\'s ready'); ui(source.title)"))
    .toEqual(['Save', 'Name', "It's ready"])
})

Deno.test('every explicit literal UI message has a Japanese catalog entry', async () => {
  const missing: string[] = []
  const walk = async (directory: URL): Promise<void> => {
    for await (const entry of Deno.readDir(directory)) {
      const path = new URL(entry.name + (entry.isDirectory ? '/' : ''), directory)
      if (entry.isDirectory) await walk(path)
      else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) {
        const keys = literalUiKeys(await Deno.readTextFile(path))
        missing.push(...missingPortalMessages(keys).map((key) => `${path.pathname}: ${key}`))
      }
    }
  }
  await walk(new URL('../', import.meta.url))
  expect(missing.sort()).toEqual([])
})
