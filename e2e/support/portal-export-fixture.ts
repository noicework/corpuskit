import { expect } from '@std/expect'

/** Independent ZIP local-header reader for assertions. The e2e also checks Python's CRCs. */
export function readExportZip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const decoder = new TextDecoder()
  const files = new Map<string, string>()
  let offset = 0
  while (view.getUint32(offset, true) === 0x04034b50) {
    expect(view.getUint16(offset + 8, true)).toBe(0)
    const size = view.getUint32(offset + 18, true)
    const nameLength = view.getUint16(offset + 26, true)
    const extraLength = view.getUint16(offset + 28, true)
    const name = decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength))
    const start = offset + 30 + nameLength + extraLength
    expect(files.has(name)).toBe(false)
    files.set(name, decoder.decode(bytes.subarray(start, start + size)))
    offset = start + size
  }
  expect(view.getUint32(offset, true)).toBe(0x02014b50)
  expect(view.getUint32(bytes.length - 22, true)).toBe(0x06054b50)
  expect(view.getUint16(bytes.length - 12, true)).toBe(files.size)
  return files
}
