/**
 * End-to-end smoke test, no DSH kernel involved.
 *
 *   node test/smoke.mjs
 *
 * Builds a throwaway DSH_HOME, starts a minimal WebDAV server in-process
 * (MKCOL/PUT/GET/DELETE), runs the engine twice and asserts the second run is
 * a no-op — the whole point of the size+mtime fast path — and that a restore
 * reproduces the bytes.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine } from '../lib/engine.js'
import { createTarget } from '../lib/targets.js'
import { readZipList } from '../lib/zip.js'

const root = await mkdtemp(join(tmpdir(), 'dsbk-smoke-'))

async function seedHome() {
  const home = join(root, 'dsh-home')
  const sessionDir = join(home, 'sessions', '--D--Project--demo--', 'sess-1')
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.jsonl'), '{"type":"session","version":1}\n', 'utf8')
  await mkdir(join(home, 'attachments'), { recursive: true })
  await writeFile(join(home, 'attachments', 'a1.png'), Buffer.alloc(2048, 7))
  await writeFile(join(home, 'attachments', 'big.bin'), Buffer.alloc(4096, 3))
  await mkdir(join(home, 'storages'), { recursive: true })
  await writeFile(join(home, 'storages', 'workspace.json'), '{"workspaces":[]}', 'utf8')
  return home
}

/** Minimal WebDAV: enough verbs for the mirror. Mounted at /dav/backup. */
function startDav() {
  const files = new Map()
  const dirs = new Set([''])
  const BASE = '/dav/backup'
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const full = decodeURIComponent(url.pathname)
    if (!full.startsWith(BASE)) {
      res.writeHead(404).end()
      return
    }
    const path = full.slice(BASE.length).replace(/^\/+/, '')
    if (req.method === 'PROPFIND') {
      // Enough of RFC 4918 for the target's root detection: a collection answers
      // 207, anything missing answers 404.
      if (path !== '' && !dirs.has(path) && !files.has(path)) {
        res.writeHead(404).end()
        return
      }
      res
        .writeHead(207, { 'content-type': 'application/xml; charset=utf-8' })
        .end('<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>/</D:href></D:response></D:multistatus>')
      return
    }
    if (req.method === 'MKCOL') {
      const parent = path.split('/').slice(0, -1).join('/')
      if (parent !== '' && !dirs.has(parent)) {
        res.writeHead(409).end()
        return
      }
      if (dirs.has(path)) {
        res.writeHead(405).end()
        return
      }
      dirs.add(path)
      res.writeHead(201).end()
      return
    }
    if (req.method === 'PUT') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      files.set(path, Buffer.concat(chunks))
      res.writeHead(201).end()
      return
    }
    if (req.method === 'GET') {
      const value = files.get(path)
      if (value === undefined) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(value)
      return
    }
    if (req.method === 'MOVE') {
      const destination = decodeURIComponent(new URL(String(req.headers.destination ?? ''), 'http://127.0.0.1').pathname)
      if (!destination.startsWith(BASE)) {
        res.writeHead(400).end()
        return
      }
      const to = destination.slice(BASE.length).replace(/^\/+/, '')
      const value = files.get(path)
      if (value === undefined) {
        res.writeHead(404).end()
        return
      }
      files.set(to, value)
      files.delete(path)
      res.writeHead(201).end()
      return
    }
    if (req.method === 'DELETE') {
      files.delete(path)
      res.writeHead(204).end()
      return
    }
    res.writeHead(405).end()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        server,
        files,
        url: `http://127.0.0.1:${port}/dav/backup`,
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

const home = await seedHome()
const dav = await startDav()
const stateDir = join(root, 'state')

let flushCount = 0
const engine = createEngine({
  dshHome: home,
  host: 'test-host',
  prefix: 'dsh-session-backup/test-host',
  statePath: join(stateDir, 'state.json'),
  lockPath: join(stateDir, 'backup.lock'),
  scope: { sessions: true, attachments: true, storages: true, maxAttachmentMB: 0, maxFileMB: 0 },
  concurrency: 2,
  prune: false,
  log: () => {},
  flushLiveSessions: async () => {
    flushCount += 1
  },
  targetFactory: () =>
    createTarget({ kind: 'webdav', url: dav.url, username: 'u', password: 'p', timeoutMs: 5000 }),
})

await engine.init()

// ---- first run: everything is new ----------------------------------------
const first = await engine.run('test')
assert.equal(first.ok, true, 'first run should succeed')
assert.equal(flushCount, 1, 'flush barrier must run exactly once')
assert.equal(first.status.uploaded, 4, `expected 4 uploads, got ${first.status.uploaded}`)
assert.equal(first.status.failed, 0, `unexpected failures: ${JSON.stringify(first.status.errors)}`)
assert.ok(first.status.bytes > 6000, 'byte counter should reflect uploaded payload')

// Remote layout: prefixed keys + manifest.
const putKeys = [...dav.files.keys()]
assert.ok(putKeys.includes('dsh-session-backup/test-host/sessions/--D--Project--demo--/sess-1/session.jsonl'), 'session log key')
assert.ok(putKeys.includes('dsh-session-backup/test-host/attachments/a1.png'), 'attachment key')
assert.ok(putKeys.includes('dsh-session-backup/test-host/storages/workspace.json'), 'storage key')
assert.ok(putKeys.includes('dsh-session-backup/test-host/manifest.json'), 'manifest key')

// A destination folder that does not exist yet: the server answers 409 until
// the ancestors are created, and the target is expected to create them itself.
const nested = createTarget({
  kind: 'webdav',
  url: `${dav.url}/nested/deep`,
  username: 'u',
  password: 'p',
  timeoutMs: 5000,
})
await nested.putText('sub/hello.txt', 'hello')
assert.equal(String(await nested.getText('sub/hello.txt')), 'hello', 'nested destination is created on demand')
const nestedProbe = await nested.probe()
assert.equal(nestedProbe.ok, true, 'probe works against a freshly created destination')

// Same server, but the user pasted the URL without its WebDAV prefix: the target
// is expected to find `/dav` at the origin and adopt `…/dav/backup` itself.
const prefixed = createTarget({
  kind: 'webdav',
  url: `${dav.origin}/backup`,
  username: 'u',
  password: 'p',
  timeoutMs: 5000,
})
const prefixedProbe = await prefixed.probe()
assert.equal(prefixedProbe.ok, true, 'a missing WebDAV prefix is detected automatically')
assert.equal(prefixed.address, dav.url, 'the resolved address includes the WebDAV prefix')

const manifest = JSON.parse(dav.files.get('dsh-session-backup/test-host/manifest.json').toString('utf8'))
assert.equal(Object.keys(manifest.files).sort().length, 4, 'manifest lists all four files')
assert.equal(manifest.files['attachments/a1.png'].size, 2048, 'manifest records sizes')

// ---- second run: nothing changed, no upload ------------------------------
const second = await engine.run('test')
assert.equal(second.ok, true)
assert.equal(second.status.uploaded, 0, 'unchanged tree must upload nothing')
assert.equal(second.status.skipped, 4, 'all four files skipped by the fast path')

// ---- touch one file: only that one is re-uploaded ------------------------
await writeFile(join(home, 'storages', 'workspace.json'), '{"workspaces":["x"]}', 'utf8')
const third = await engine.run('test')
assert.equal(third.status.uploaded, 1, 'only the changed file is uploaded')
assert.equal(third.status.skipped, 3)

// ---- same-size, same-hash rewrite must not re-upload ---------------------
const a1 = join(home, 'attachments', 'a1.png')
const bytes = await readFile(a1)
await new Promise((resolve) => setTimeout(resolve, 15))
await writeFile(a1, bytes) // new mtime, identical bytes
const fourth = await engine.run('test')
assert.equal(fourth.status.uploaded, 0, 'identical bytes must be skipped even with a new mtime')

// ---- size cap: oversized attachment is reported, not uploaded ------------
const capped = createEngine({
  dshHome: home,
  host: 'test-host',
  prefix: 'dsh-session-backup/test-host',
  statePath: join(root, 'state2', 'state.json'),
  lockPath: join(root, 'state2', 'backup.lock'),
  scope: { sessions: true, attachments: true, storages: true, maxAttachmentMB: 0.001, maxFileMB: 0 },
  log: () => {},
  flushLiveSessions: async () => {},
  targetFactory: () => createTarget({ kind: 'webdav', url: dav.url, username: 'u', password: 'p', timeoutMs: 5000 }),
})
await capped.init()
const cappedRun = await capped.run('test')
assert.equal(cappedRun.status.skippedByLimit.length, 2, 'both attachments exceed 1 KB and are skipped by cap')
assert.equal(cappedRun.status.failed, 0)

// ---- restore round-trip --------------------------------------------------
const restoreDir = join(root, 'restored')
const restored = await engine.restore({ dest: restoreDir, only: 'storages/' })
assert.equal(restored.ok, true)
assert.equal(restored.restored, 1)
const restoredText = await readFile(join(restoreDir, 'storages', 'workspace.json'), 'utf8')
assert.equal(restoredText, '{"workspaces":["x"]}', 'restored bytes match the mirror')

// ---- guards --------------------------------------------------------------
await assert.rejects(() => engine.restore({ dest: home }), /正在使用的 DSH 数据目录/)
await assert.rejects(
  () => engine.restore({ dest: join(home, 'sessions') }),
  /正在使用的 DSH 数据目录/,
)

// ---- directory target parity --------------------------------------------
const dirRoot = join(root, 'dir-target')
const dirEngine = createEngine({
  dshHome: home,
  host: 'test-host',
  prefix: 'mirror',
  statePath: join(root, 'state3', 'state.json'),
  lockPath: join(root, 'state3', 'backup.lock'),
  scope: { sessions: true, attachments: true, storages: true, maxAttachmentMB: 0, maxFileMB: 0 },
  log: () => {},
  flushLiveSessions: async () => {},
  targetFactory: () => createTarget({ kind: 'dir', root: dirRoot }),
})
await dirEngine.init()
const dirRun = await dirEngine.run('test')
assert.equal(dirRun.ok, true)
const mirrored = await stat(join(dirRoot, 'mirror', 'storages', 'workspace.json'))
assert.ok(mirrored.isFile(), 'dir target mirrors the same layout')
const dirManifest = JSON.parse(await readFile(join(dirRoot, 'mirror', 'manifest.json'), 'utf8'))
assert.ok(dirManifest.files['storages/workspace.json'].sha256.length === 64, 'manifest carries sha256')

// ---- version history (WebDAV MOVE), verification -------------------------
const versionEngine = createEngine({
  dshHome: home,
  host: 'test-host',
  prefix: 'versioned',
  statePath: join(root, 'state4', 'state.json'),
  lockPath: join(root, 'state4', 'backup.lock'),
  scope: { sessions: true, attachments: true, storages: true, maxAttachmentMB: 0, maxFileMB: 0 },
  versionsKeep: 2,
  retries: 0,
  log: () => {},
  flushLiveSessions: async () => {},
  targetFactory: () => createTarget({ kind: 'webdav', url: dav.url, username: 'u', password: 'p', timeoutMs: 5000 }),
})
await versionEngine.init()
await versionEngine.run('test')
await writeFile(join(home, 'storages', 'workspace.json'), '{"workspaces":["v2"]}', 'utf8')
const versionedRun = await versionEngine.run('test')
assert.equal(versionedRun.ok, true)
assert.equal(versionedRun.status.versioned, 1, 'the previous copy is archived before the overwrite')
const versionKeys = [...dav.files.keys()].filter((entry) => entry.startsWith('versioned/versions/storages/workspace.json/'))
assert.equal(versionKeys.length, 1, 'exactly one version kept')
const restoredVersion = dav.files.get(versionKeys[0]).toString('utf8')
assert.equal(restoredVersion, '{"workspaces":["x"]}', 'the archived copy holds the previous bytes')

const verified = await versionEngine.verify({ sample: 4 })
assert.equal(verified.ok, true, `verify should pass: ${JSON.stringify(verified.errors)}`)
assert.ok(verified.checked >= 3, 'verify reads a sample back')

// ---- exclude rules, mirror delete, dir target ---------------------------
const policyRoot = join(root, 'policy-target')
const policyEngine = createEngine({
  dshHome: home,
  host: 'test-host',
  prefix: 'policy',
  statePath: join(root, 'state5', 'state.json'),
  lockPath: join(root, 'state5', 'backup.lock'),
  scope: { sessions: true, attachments: true, storages: true, maxAttachmentMB: 0, maxFileMB: 0 },
  exclude: ['*.log'],
  deleteMode: 'mirror',
  log: () => {},
  flushLiveSessions: async () => {},
  targetFactory: () => createTarget({ kind: 'dir', root: policyRoot }),
})
await writeFile(join(home, 'attachments', 'debug.log'), 'noise', 'utf8')
await policyEngine.init()
const policyRun = await policyEngine.run('test')
assert.equal(policyRun.ok, true)
assert.equal(policyRun.status.excluded, 1, 'the exclusion pattern drops exactly one file')
const policyManifest = JSON.parse(await readFile(join(policyRoot, 'policy', 'manifest.json'), 'utf8'))
assert.equal(Object.keys(policyManifest.files).some((entry) => entry.endsWith('.log')), false, 'excluded file is not mirrored')

// Mirror mode: a file removed locally disappears remotely too.
await rm(join(home, 'attachments', 'a1.png'), { force: true })
const mirrorRun = await policyEngine.run('test')
assert.equal(mirrorRun.ok, true)
assert.ok(mirrorRun.status.pruned >= 1, 'mirror mode prunes the file that vanished locally')
assert.equal(policyManifest.files['attachments/a1.png'] !== undefined, true, 'pre-run manifest snapshot proves it was there')
const mirroredManifest = JSON.parse(await readFile(join(policyRoot, 'policy', 'manifest.json'), 'utf8'))
assert.equal(mirroredManifest.files['attachments/a1.png'], undefined, 'the pruned key is gone from the new manifest')

// ---- archive (zip) mode --------------------------------------------------
const archiveRoot = join(root, 'archive-target')
const archiveEngine = createEngine({
  dshHome: home,
  host: 'test-host',
  prefix: 'zip',
  statePath: join(root, 'state6', 'state.json'),
  lockPath: join(root, 'state6', 'backup.lock'),
  scope: { sessions: true, attachments: true, storages: true, maxAttachmentMB: 0, maxFileMB: 0 },
  archiveMode: 'zip',
  archiveKeep: 2,
  retries: 0,
  log: () => {},
  flushLiveSessions: async () => {},
  targetFactory: () => createTarget({ kind: 'dir', root: archiveRoot }),
})
await archiveEngine.init()
const zipRun = await archiveEngine.run('test')
assert.equal(zipRun.ok, true)
assert.equal(zipRun.status.archive.mode, 'zip')
assert.equal(zipRun.status.uploaded, 1, 'zip mode uploads exactly one object')
const archivesDir = join(archiveRoot, 'zip', 'archive')
const firstArchives = (await readdir(archivesDir)).filter((entry) => entry.endsWith('.zip'))
assert.equal(firstArchives.length, 1, 'one archive after the first run')
const firstArchivePath = join(archivesDir, firstArchives[0])
const listedEntries = await readZipList(firstArchivePath)
assert.ok(listedEntries.length >= 3, `archive holds every selected file: ${listedEntries.length}`)
assert.ok(listedEntries.some((entry) => entry.path === 'storages/workspace.json'))

const zipManifest = JSON.parse(await readFile(join(archiveRoot, 'zip', 'manifest.json'), 'utf8'))
assert.equal(zipManifest.archive.entries, listedEntries.length, 'manifest records the entry count')
assert.equal(Object.keys(zipManifest.files).length, 0, 'zip mode keeps no per-file manifest')
assert.equal(zipManifest.archive.sha256.length, 64)

// An unchanged run re-packs identical bytes (timestamps are not stored in the
// file bytes), so the upload is skipped.
const zipAgain = await archiveEngine.run('test')
assert.equal(zipAgain.ok, true)
assert.equal(zipAgain.status.uploaded, 0, 'identical content skips the archive upload')
assert.equal(zipAgain.status.skipped >= 1, true)

// A change forces a new archive, and `archiveKeep` prunes the oldest.
await writeFile(join(home, 'storages', 'workspace.json'), '{"workspaces":["zip3"]}', 'utf8')
const zipChanged = await archiveEngine.run('test')
assert.equal(zipChanged.ok, true)
assert.equal(zipChanged.status.uploaded, 1)
const afterChange = (await readdir(archivesDir)).filter((entry) => entry.endsWith('.zip'))
assert.equal(afterChange.length, 2, 'archiveKeep keeps the newest two archives')
const zipVerify = await archiveEngine.verify()
assert.equal(zipVerify.ok, true, `archive verify should pass: ${JSON.stringify(zipVerify.errors)}`)
assert.equal(zipVerify.mode, 'zip')
assert.equal(zipVerify.checked, 1)

// Retention has to survive a restart: the archive list lives in state.json.
const restarted = createEngine({
  dshHome: home,
  host: 'test-host',
  prefix: 'zip',
  statePath: join(root, 'state6', 'state.json'),
  lockPath: join(root, 'state6', 'backup.lock'),
  scope: { sessions: true, attachments: true, storages: true, maxAttachmentMB: 0, maxFileMB: 0 },
  archiveMode: 'zip',
  archiveKeep: 2,
  retries: 0,
  log: () => {},
  flushLiveSessions: async () => {},
  targetFactory: () => createTarget({ kind: 'dir', root: archiveRoot }),
})
await restarted.init()
await writeFile(join(home, 'storages', 'workspace.json'), '{"workspaces":["zip4"]}', 'utf8')
const restartRun = await restarted.run('test')
assert.equal(restartRun.ok, true)
assert.equal(restartRun.status.pruned, 1, 'a fresh process still prunes down to archiveKeep')
const afterRestart = (await readdir(archivesDir)).filter((entry) => entry.endsWith('.zip'))
assert.equal(afterRestart.length, 2, 'archiveKeep holds across restarts')

// Restore from an archive into an empty directory: bytes must match exactly.
const zipRestore = join(root, 'zip-restored')
const zipRestored = await archiveEngine.restore({ dest: zipRestore })
assert.equal(zipRestored.mode, 'zip')
assert.equal(zipRestored.ok, true, `zip restore errors: ${JSON.stringify(zipRestored.errors)}`)
assert.equal(await readFile(join(zipRestore, 'storages', 'workspace.json'), 'utf8'), '{"workspaces":["zip4"]}')
assert.equal(zipRestored.restored, listedEntries.length)
const zipDry = await archiveEngine.restore({ dest: join(root, 'zip-dry'), dryRun: true })
assert.equal(zipDry.dryRun, true)
assert.ok(zipDry.total >= 3, 'dry run reports the archive entry count from the manifest')

// ---- probe ---------------------------------------------------------------
const probe = await engine.probe()
assert.equal(probe.ok, true, 'probe writes, reads back and deletes')

await dav.close()
await rm(root, { recursive: true, force: true })

console.log('smoke: all assertions passed')
