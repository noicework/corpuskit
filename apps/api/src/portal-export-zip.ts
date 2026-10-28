/** Small, store-only ZIP writer. No Node APIs, compression library or temporary files. */
const encoder = new TextEncoder()
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  return value >>> 0
})

export class ExportLimitError extends Error {
  constructor() {
    super('Portal export exceeds its size or record limit')
  }
}

function header(size: number, values: [number, number, 2 | 4][]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size)
  const view = new DataView(bytes.buffer)
  for (const [offset, value, length] of values) {
    if (length === 2) view.setUint16(offset, value, true)
    else view.setUint32(offset, value, true)
  }
  return bytes
}

/** Incrementally encodes records into a bounded spool before the mandatory completion audit. */
export class ExportZip {
  private parts: BlobPart[] = []
  private directory: BlobPart[] = []
  private bytes = 0
  private directoryBytes = 0
  readonly entries: { path: string; bytes: number }[] = []

  constructor(private readonly maxBytes: number, private readonly signal: AbortSignal) {}

  async add(path: string, text: Iterable<string> | AsyncIterable<string>): Promise<void> {
    this.signal.throwIfAborted()
    const name = encoder.encode(path)
    const offset = this.bytes
    const data: BlobPart[] = []
    let size = 0
    let crc = 0xffffffff
    const overhead = 30 + name.length + 46 + name.length
    for await (const part of text) {
      this.signal.throwIfAborted()
      // UTF-8 has at least one byte per code unit, except surrogate pairs (two units, four bytes).
      if (part.length > this.maxBytes) throw new ExportLimitError()
      const bytes = encoder.encode(part)
      size += bytes.length
      if (this.bytes + this.directoryBytes + overhead + size + 22 > this.maxBytes) {
        throw new ExportLimitError()
      }
      for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]!
      data.push(bytes)
    }
    crc = (crc ^ 0xffffffff) >>> 0
    // UTF-8 flag, no compression, canonical DOS timestamp 1980-01-01.
    this.parts.push(
      header(30, [
        [0, 0x04034b50, 4],
        [4, 20, 2],
        [6, 0x800, 2],
        [12, 33, 2],
        [14, crc, 4],
        [18, size, 4],
        [22, size, 4],
        [26, name.length, 2],
      ]),
      name,
      new Blob(data),
    )
    this.directory.push(
      header(46, [
        [0, 0x02014b50, 4],
        [4, 20, 2],
        [6, 20, 2],
        [8, 0x800, 2],
        [14, 33, 2],
        [16, crc, 4],
        [20, size, 4],
        [24, size, 4],
        [28, name.length, 2],
        [42, offset, 4],
      ]),
      name,
    )
    this.bytes += 30 + name.length + size
    this.directoryBytes += 46 + name.length
    this.entries.push({ path, bytes: size })
  }

  finish(): Blob {
    this.signal.throwIfAborted()
    return new Blob([
      ...this.parts,
      ...this.directory,
      header(22, [
        [0, 0x06054b50, 4],
        [8, this.entries.length, 2],
        [10, this.entries.length, 2],
        [12, this.directoryBytes, 4],
        [16, this.bytes, 4],
      ]),
    ], { type: 'application/zip' })
  }
}
