/**
 * ZIP container test: our writer/reader must round-trip, and the archive must
 * be readable by a real ZIP implementation (PowerShell Expand-Archive) — the
 * point of using STORE + data descriptors is exactly that interoperability.
 *
 *   node test/zip.mjs
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, extractZip, readZipList, writeZip } from '../lib/zip.js'

/**
 * Run a Windows tool with inherited stdio: this harness denies piped stdio to
 * child processes (EPERM), so nothing here may capture output.
 */
function runInherit(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}`))))
  })
}

const root = await mkdtemp(join(tmpdir(), 'dsbk-zip-'))
const source = join(root, 'source')
await mkdir(join(source, 'sessions', 'proj', 'sess-1'), { recursive: true })
await mkdir(join(source, 'attachments'), { recursive: true })

const big = Buffer.alloc(1024 * 1024)
for (let index = 0; index < big.length; index += 1) big[index] = index % 251
await writeFile(join(source, 'attachments', 'big.bin'), big)
await writeFile(join(source, 'sessions', 'proj', 'sess-1', 'session.jsonl'), '{"type":"session"}\n')
await writeFile(join(source, 'attachments', 'empty.dat'), Buffer.alloc(0))
await writeFile(join(source, 'attachments', '中文名字.txt'), '中文内容\n', 'utf8')

const entries = [
  { path: 'attachments/big.bin', abs: join(source, 'attachments', 'big.bin') },
  { path: 'attachments/empty.dat', abs: join(source, 'attachments', 'empty.dat') },
  { path: 'attachments/中文名字.txt', abs: join(source, 'attachments', '中文名字.txt') },
  { path: 'sessions/proj/sess-1/session.jsonl', abs: join(source, 'sessions', 'proj', 'sess-1', 'session.jsonl') },
]

// ---- write ---------------------------------------------------------------
const archive = join(root, 'out', 'pack.zip')
const seen = []
const written = await writeZip(archive, entries, { onEntry: (item) => seen.push(item.path) })
assert.equal(written.entries, 4)
assert.deepEqual(seen, entries.map((entry) => entry.path))
const archiveInfo = await stat(archive)
assert.equal(written.bytes, archiveInfo.size, 'reported byte count matches the file on disk')
// STORE: the archive is at least the payload plus headers.
assert.ok(written.bytes > big.length, 'store-mode archive is payload plus framing')

// ---- read back -----------------------------------------------------------
const listed = await readZipList(archive)
assert.equal(listed.length, 4)
const bigEntry = listed.find((entry) => entry.path === 'attachments/big.bin')
assert.equal(bigEntry.size, big.length)
assert.equal(bigEntry.crc32, crc32(big), 'CRC-32 matches a direct computation')

const dest = join(root, 'extracted')
const result = await extractZip(archive, dest)
assert.equal(result.entries, 4)
assert.equal(result.extracted, 4, `extract errors: ${JSON.stringify(result.errors)}`)
assert.equal(result.failed, 0)
assert.deepEqual(await readFile(join(dest, 'attachments', 'big.bin')), big)
assert.equal(await readFile(join(dest, 'attachments', '中文名字.txt'), 'utf8'), '中文内容\n')
assert.equal((await stat(join(dest, 'attachments', 'empty.dat'))).size, 0)

// ---- prefix extraction ---------------------------------------------------
const partial = join(root, 'partial')
const onlySessions = await extractZip(archive, partial, { only: 'sessions/' })
assert.equal(onlySessions.entries, 1)
assert.equal(onlySessions.extracted, 1)

// ---- interop: a real ZIP reader must accept our archive ------------------
if (process.platform === 'win32') {
  const winDest = join(root, 'win-extracted')
  await runInherit('powershell.exe', [
    '-NoProfile',
    '-Command',
    `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${winDest}' -Force`,
  ])
  assert.deepEqual(await readFile(join(winDest, 'attachments', 'big.bin')), big, 'PowerShell extracts identical bytes')
}

// ---- interop: our reader must accept a real ZIP writer -------------------
if (process.platform === 'win32') {
  const foreign = join(root, 'foreign.zip')
  const foreignSource = join(root, 'foreign-source')
  await mkdir(foreignSource, { recursive: true })
  await writeFile(join(foreignSource, 'hello.txt'), 'hello\n')
  await runInherit('powershell.exe', [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path '${join(foreignSource, 'hello.txt')}' -DestinationPath '${foreign}' -Force`,
  ])
  // Compress-Archive deflates, so listing must be rejected with a clear message.
  let rejected = false
  try {
    await readZipList(foreign)
  } catch (error) {
    rejected = /不支持的压缩方式/.test(String(error?.message ?? error))
  }
  assert.equal(rejected, true, 'a deflated archive is rejected with a readable error')
}

await rm(root, { recursive: true, force: true })
console.log('zip: all assertions passed')
