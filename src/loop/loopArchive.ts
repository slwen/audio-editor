/** Uncompressed ZIP: WAV is already PCM; one download avoids browser batch limits. */
export type ArchiveEntry = { name: string; bytes: Uint8Array<ArrayBuffer> }

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

export function createLoopArchive(entries: ArchiveEntry[]): Blob {
  const chunks: BlobPart[] = []
  const directory: BlobPart[] = []
  let offset = 0
  let directorySize = 0
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name)
    const size = entry.bytes.byteLength
    if (size > 0xffffffff || offset + size > 0xffffffff) throw new Error('Loop pack exceeds ZIP size limit')
    let crc = 0xffffffff
    for (const byte of entry.bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8)
    crc = (crc ^ 0xffffffff) >>> 0
    const header = new Uint8Array(30 + name.length)
    const view = new DataView(header.buffer)
    view.setUint32(0, 0x04034b50, true)
    view.setUint16(4, 20, true)
    view.setUint16(6, 0x800, true) // UTF-8
    view.setUint16(12, 33, true) // 1980-01-01
    view.setUint32(14, crc, true)
    view.setUint32(18, size, true)
    view.setUint32(22, size, true)
    view.setUint16(26, name.length, true)
    header.set(name, 30)
    chunks.push(header, entry.bytes)

    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    central.set(header.subarray(4, 30), 6)
    cv.setUint32(42, offset, true)
    central.set(name, 46)
    directory.push(central)
    directorySize += central.length
    offset += header.length + size
  }
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, directorySize, true)
  ev.setUint32(16, offset, true)
  return new Blob([...chunks, ...directory, end], { type: 'application/zip' })
}
