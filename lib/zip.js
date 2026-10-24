/**
 * Minimal streaming ZIP writer/reader, STORE only, no dependencies.
 *
 * Why not `zlib`: the payload is already compressed (session logs are zstd
 * frames, attachments are PNG/JPEG/MP4), so a second deflate pass costs CPU
 * and buys nothing. STORE keeps the archive byte-transparent and lets us
 * stream 300 MB of sources into one file without buffering it in memory.
 *
 * Supported subset (what every unzip implementation understands):
 *   - single-disk archive, no encryption, no zip64 (4 GiB per file / archive)
 *   - local header with a data descriptor (bit 3) so entries can stream
 *   - UTF-8 file names (bit 11)
 */

import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'

const SIG_LOCAL = 0x04034b50
const SIG_DESCRIPTOR = 0x08074b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50

const FLAGS = 0x0800 | 0x0008 // UTF-8 names + data descriptor
const METHOD_STORE = 0

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

/** Incremental CRC-32 (the ZIP polynomial), updated chunk by chunk. */
export function crc32Update(crc, chunk) {
  let value = crc >>> 0
  for (let index = 0; index < chunk.length; index += 1) {
    value = CRC_TABLE[(value ^ chunk[index]) & 0xff] ^ (value >>> 8)
  }
  return value >>> 0
}

export function crc32(buffer) {
  return (crc32Update(0xffffffff, buffer) ^ 0xffffffff) >>> 0
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear())
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time: time & 0xffff, date: day & 0xffff }
}

function u16(value) {
  const buffer = Buffer.alloc(2)
  buffer.writeUInt16LE(value & 0xffff, 0)
  return buffer
}

function u32(value) {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value >>> 0, 0)
  return buffer
}

async function writeAll(stream, buffers) {
  for (const buffer of buffers) {
    if (stream.write(buffer) === false) await new Promise((resolve) => stream.once('drain', resolve))
  }
}

/** FileHandle.read may return short reads; ZIP parsing needs exact slices. */
async function readExact(handle, buffer, position) {
  let done = 0
  while (done < buffer.length) {
    const { bytesRead } = await handle.read(buffer, done, buffer.length - done, position + done)
    if (bytesRead === 0) throw new Error('ZIP 文件被截断')
    done += bytesRead
  }
  return buffer
}

/**
 * Write `entries` (`[{ path, abs }]`) into one STORE zip at `outPath`.
 * `onEntry` runs after each entry so callers can report progress.
 */
export async function writeZip(outPath, entries, { onEntry, signal } = {}) {
  await mkdir(dirname(outPath), { recursive: true })
  const stream = createWriteStream(outPath)
  const central = []
  let offset = 0
  const startedAt = new Date()

  try {
    for (const entry of entries) {
      if (signal?.aborted === true) throw new Error('打包已取消')
      const info = await stat(entry.abs)
      const name = Buffer.from(entry.path.replace(/\\/g, '/'), 'utf8')
      const { time, date } = dosDateTime(info.mtime ?? startedAt)
      const header = Buffer.concat([
        u32(SIG_LOCAL),
        u16(20),
        u16(FLAGS),
        u16(METHOD_STORE),
        u16(time),
        u16(date),
        u32(0),
        u32(0),
        u32(0),
        u16(name.length),
        u16(0),
        name,
      ])
      const localOffset = offset
      await writeAll(stream, [header])
      offset += header.length

      let crc = 0xffffffff
      let size = 0
      for await (const chunk of createReadStream(entry.abs)) {
        crc = crc32Update(crc, chunk)
        size += chunk.length
        if (stream.write(chunk) === false) await new Promise((resolve) => stream.once('drain', resolve))
      }
      crc = (crc ^ 0xffffffff) >>> 0
      offset += size

      const descriptor = Buffer.concat([u32(SIG_DESCRIPTOR), u32(crc), u32(size), u32(size)])
      await writeAll(stream, [descriptor])
      offset += descriptor.length

      central.push({ name, crc, size, offset: localOffset, time, date })
      onEntry?.({ path: entry.path, size })
    }

    const centralStart = offset
    let centralSize = 0
    for (const item of central) {
      const record = Buffer.concat([
        u32(SIG_CENTRAL),
        u16(20),
        u16(20),
        u16(FLAGS),
        u16(METHOD_STORE),
        u16(item.time),
        u16(item.date),
        u32(item.crc),
        u32(item.size),
        u32(item.size),
        u16(item.name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(item.offset),
        item.name,
      ])
      await writeAll(stream, [record])
      centralSize += record.length
      offset += record.length
    }

    const eocd = Buffer.concat([
      u32(SIG_EOCD),
      u16(0),
      u16(0),
      u16(central.length),
      u16(central.length),
      u32(centralSize),
      u32(centralStart),
      u16(0),
    ])
    await writeAll(stream, [eocd])
    offset += eocd.length
  } finally {
    await new Promise((resolve, reject) => {
      stream.once('error', reject)
      stream.end(resolve)
    })
  }

  const info = await stat(outPath)
  return { bytes: info.size, entries: central.length }
}

/** Read the central directory of a STORE zip; throws on compressed entries. */
export async function readZipList(filePath) {
  const info = await stat(filePath)
  const handle = await open(filePath, 'r')
  try {
    const tailLength = Math.min(info.size, 66 * 1024)
    const tail = Buffer.alloc(tailLength)
    await readExact(handle, tail, info.size - tailLength)
    let eocdAt = -1
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === SIG_EOCD) {
        eocdAt = index
        break
      }
    }
    if (eocdAt < 0) throw new Error('不是有效的 ZIP：找不到目录结尾')
    const count = tail.readUInt16LE(eocdAt + 10)
    const centralSize = tail.readUInt32LE(eocdAt + 12)
    const centralOffset = tail.readUInt32LE(eocdAt + 16)
    const central = Buffer.alloc(centralSize)
    await readExact(handle, central, centralOffset)

    const entries = []
    let at = 0
    for (let index = 0; index < count; index += 1) {
      if (central.readUInt32LE(at) !== SIG_CENTRAL) throw new Error('ZIP 目录结构损坏')
      const method = central.readUInt16LE(at + 10)
      const crc = central.readUInt32LE(at + 16)
      const size = central.readUInt32LE(at + 20)
      const nameLength = central.readUInt16LE(at + 28)
      const extraLength = central.readUInt16LE(at + 30)
      const commentLength = central.readUInt16LE(at + 32)
      const offset = central.readUInt32LE(at + 42)
      const name = central.subarray(at + 46, at + 46 + nameLength).toString('utf8')
      if (method !== METHOD_STORE) throw new Error(`不支持的压缩方式（${method}）：只支持 STORE 归档`)
      entries.push({ path: name, size, crc32: crc, offset })
      at += 46 + nameLength + extraLength + commentLength
    }
    return entries
  } finally {
    await handle.close()
  }
}

/**
 * Extract a STORE zip into `destRoot`. `only` narrows to a path prefix;
 * `verify` recomputes CRC-32 per entry and fails that entry on mismatch.
 */
export async function extractZip(filePath, destRoot, { only = '', verify = true, onEntry } = {}) {
  const entries = await readZipList(filePath)
  const selected = only === '' ? entries : entries.filter((entry) => entry.path.startsWith(only))
  const errors = []
  let extracted = 0
  const handle = await open(filePath, 'r')

  try {
    for (const entry of selected) {
      const target = join(destRoot, ...entry.path.split('/'))
      try {
        const header = Buffer.alloc(30)
        await readExact(handle, header, entry.offset)
        if (header.readUInt32LE(0) !== SIG_LOCAL) throw new Error('ZIP 条目头损坏')
        const nameLength = header.readUInt16LE(26)
        const extraLength = header.readUInt16LE(28)
        const dataOffset = entry.offset + 30 + nameLength + extraLength
        await mkdir(dirname(target), { recursive: true })

        let crc = 0xffffffff
        let written = 0
        if (entry.size === 0) {
          await writeFile(target, Buffer.alloc(0))
        } else {
          const reader = createReadStream(filePath, { start: dataOffset, end: dataOffset + entry.size - 1 })
          const sink = createWriteStream(target)
          reader.on('data', (chunk) => {
            crc = crc32Update(crc, chunk)
            written += chunk.length
          })
          await pipeline(reader, sink)
        }
        const actual = (crc ^ 0xffffffff) >>> 0
        if (verify && entry.size > 0 && actual !== entry.crc32) throw new Error('CRC-32 校验不一致')
        if (written !== entry.size) throw new Error('解包字节数与目录记录不一致')
        extracted += 1
        onEntry?.({ path: entry.path, size: entry.size })
      } catch (error) {
        if (errors.length < 20) errors.push({ path: entry.path, message: String(error?.message ?? error) })
      }
    }
  } finally {
    await handle.close()
  }

  return { entries: selected.length, extracted, failed: errors.length, errors }
}

/** Read one entry from a STORE zip into memory (small files only). */
export async function readZipEntry(filePath, wanted) {
  const entries = await readZipList(filePath)
  const entry = entries.find((item) => item.path === wanted)
  if (entry === undefined) throw new Error(`归档里没有 ${wanted}`)
  const handle = await open(filePath, 'r')
  try {
    const header = Buffer.alloc(30)
    await readExact(handle, header, entry.offset)
    const nameLength = header.readUInt16LE(26)
    const extraLength = header.readUInt16LE(28)
    const dataOffset = entry.offset + 30 + nameLength + extraLength
    const buffer = Buffer.alloc(entry.size)
    if (entry.size > 0) await readExact(handle, buffer, dataOffset)
    return buffer
  } finally {
    await handle.close()
  }
}

export { SIG_EOCD, SIG_CENTRAL, SIG_LOCAL }
