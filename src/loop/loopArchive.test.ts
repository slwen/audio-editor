import { expect, it } from 'vitest'
import { createLoopArchive } from './loopArchive'

it('writes a ZIP directory with valid offsets, checksums and intact asset data', async () => {
  const bytes = new TextEncoder().encode('123456789')
  const zip = new DataView(await createLoopArchive([
    { name: 'combat.wav', bytes },
    { name: 'loops.json', bytes: new TextEncoder().encode('{"tags":["combat"]}') },
  ]).arrayBuffer())
  const end = zip.byteLength - 22
  expect(zip.getUint32(end, true)).toBe(0x06054b50)
  expect(zip.getUint16(end + 10, true)).toBe(2)
  const central = zip.getUint32(end + 16, true)
  expect(zip.getUint32(central, true)).toBe(0x02014b50)
  expect(zip.getUint32(central + 16, true)).toBe(0xcbf43926) // standard CRC-32 vector
  const offset = zip.getUint32(central + 42, true)
  expect(zip.getUint32(offset, true)).toBe(0x04034b50)
  const dataStart = offset + 30 + zip.getUint16(offset + 26, true)
  const compressed = new Uint8Array(zip.buffer, dataStart, zip.getUint32(offset + 18, true))
  const method = zip.getUint16(offset + 8, true)
  expect(method).toBe(0)
  const extracted = compressed
  expect(new TextDecoder().decode(extracted)).toBe('123456789')
})
