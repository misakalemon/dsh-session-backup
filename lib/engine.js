/**
 * The backup runner: scan → decide → version → upload → manifest → history.
 *
 * Decisions are taken per file:
 *   - unchanged (same size + mtime + known hash)  → skip, no read at all
 *   - size or mtime changed                       → hash, and upload only if the
 *                                                   remote does not already hold
 *                                                   those bytes
 *   - never seen locally                          → hash, upload unless the remote
 *                                                   manifest lists the same hash
 *
 * Optional behaviour borrowed from mature backup tools:
 *   - `exclude` globs drop paths before any I/O
 *   - `versionsKeep` moves the previous remote copy to `versions/…` before an
 *     overwrite, so a session file that got corrupted can be rolled back
 *   - `deleteMode: 'mirror'` also removes remote files that disappeared locally
 *   - `retries` re-attempts a failed file, `bandwidthKBps` paces the run
 *   - every run is appended to a bounded history the panel renders
 *
 * A per-file failure is recorded and the run continues: one locked attachment
 * must not stop 180 session logs from being protected.
 */

import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { readManifest, writeManifest, manifestDigest, createManifest, MANIFEST_KEY } from './manifest.js'
import { scanSources } from './scanner.js'
import { acquireLock, loadState, saveState } from './state.js'
import { backoffMs, formatBytes, isExcluded, joinKey, sha256File, sleep } from './util.js'
import { extractZip, readZipList, writeZip } from './zip.js'

const MAX_REPORTED_ERRORS = 20

export function createEngine(options) {
  const {
    dshHome,
    host,
    prefix,
    statePath,
    lockPath,
    targetFactory,
    flushLiveSessions,
    log = () => {},
    concurrency = 2,
    retries = 2,
    bandwidthKBps = 0,
    versionsKeep = 0,
    exclude = [],
    deleteMode = 'archive',
    prune = false,
    historyLimit = 20,
    archiveMode = 'mirror',
    archiveKeep = 3,
  } = options

  const mirrorMode = deleteMode === 'mirror' || prune === true
  const zipMode = archiveMode === 'zip'
  const keepArchives = Math.max(1, Math.min(50, Number(archiveKeep) || 3))
  const keepVersions = Math.max(0, Math.min(50, Number(versionsKeep) || 0))
  const maxRetries = Math.max(0, Math.min(5, Number(retries) || 0))
  const rateBytesPerSecond = Math.max(0, Number(bandwidthKBps) || 0) * 1024
  const patterns = Array.isArray(exclude) ? exclude : []

  let state = null
  const progress = {
    running: false,
    phase: 'idle',
    trigger: null,
    startedAt: null,
    done: 0,
    total: 0,
    bytes: 0,
    uploaded: 0,
    skipped: 0,
    failed: 0,
    excluded: 0,
    versioned: 0,
    pruned: 0,
    toUpload: 0,
    errors: [],
    trees: [],
    skippedByLimit: [],
  }

  const key = (rel) => joinKey(prefix, rel)

  function snapshot() {
    const files = Object.values(state?.files ?? {})
    return {
      running: progress.running,
      phase: progress.phase,
      trigger: progress.trigger,
      startedAt: progress.startedAt,
      done: progress.done,
      total: progress.total,
      uploaded: progress.uploaded,
      skipped: progress.skipped,
      failed: progress.failed,
      excluded: progress.excluded,
      versioned: progress.versioned,
      pruned: progress.pruned,
      bytes: progress.bytes,
      bytesLabel: formatBytes(progress.bytes),
      trees: progress.trees,
      skippedByLimit: progress.skippedByLimit.slice(0, 40),
      errors: progress.errors.slice(0, MAX_REPORTED_ERRORS),
      lastRun: state?.lastRun ?? null,
      history: (state?.history ?? []).slice(0, historyLimit),
      settings: {
        concurrency,
        retries: maxRetries,
        bandwidthKBps: Math.round(rateBytesPerSecond / 1024),
        versionsKeep: keepVersions,
        deleteMode: mirrorMode ? 'mirror' : 'archive',
        exclude: patterns,
        archiveMode: zipMode ? 'zip' : 'mirror',
        archiveKeep: keepArchives,
      },
      mirror: {
        host,
        prefix,
        files: files.length,
        bytes: files.reduce((sum, item) => sum + (Number(item?.size) || 0), 0),
      },
      versions: {
        sets: Object.keys(state?.versions ?? {}).length,
        files: Object.values(state?.versions ?? {}).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0),
        bytes: Object.values(state?.versions ?? {}).reduce(
          (sum, list) => sum + (Array.isArray(list) ? list.reduce((inner, item) => inner + (Number(item?.size) || 0), 0) : 0),
          0,
        ),
      },
      archive: {
        mode: zipMode ? 'zip' : 'mirror',
        keep: keepArchives,
        last: state?.archive?.last ?? null,
        count: Array.isArray(state?.archive?.list) ? state.archive.list.length : 0,
        totalBytes: Array.isArray(state?.archive?.list)
          ? state.archive.list.reduce((sum, item) => sum + (Number(item?.size) || 0), 0)
          : 0,
      },
    }
  }

  async function init() {
    state = await loadState(statePath, host)
    return snapshot()
  }

  function ensureState() {
    if (state === null) {
      state = { version: 1, host, updatedAt: new Date().toISOString(), files: {}, versions: {}, lastRun: null, history: [] }
    }
    if (!state.versions || typeof state.versions !== 'object') state.versions = {}
    if (!Array.isArray(state.history)) state.history = []
    return state
  }

  async function mapLimit(items, limit, worker) {
    let index = 0
    const size = Math.max(1, Math.min(limit, items.length))
    const workers = Array.from({ length: size }, async () => {
      for (;;) {
        const at = index
        index += 1
        if (at >= items.length) return
        await worker(items[at], at)
      }
    })
    await Promise.all(workers)
  }

  function recordError(entry, error) {
    progress.failed += 1
    if (progress.errors.length < MAX_REPORTED_ERRORS) {
      progress.errors.push({ key: entry.key ?? String(entry), message: String(error?.message ?? error) })
    }
    log('warn', `备份失败 ${entry.key ?? entry}：${error?.message ?? error}`)
  }

  /** Keep the previous remote copy before overwriting it. */
  async function archiveVersion(target, entry, previousSha) {
    if (keepVersions === 0) return false
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const shortSha = String(previousSha ?? '').slice(0, 8) || 'unknown'
    const versionKey = joinKey(prefix, 'versions', entry.key, `${stamp}-${shortSha}`)
    try {
      await target.move(key(entry.key), versionKey)
    } catch (error) {
      log('warn', `保留旧版本失败 ${entry.key}：${error?.message ?? error}`)
      return false
    }
    const list = Array.isArray(state.versions[entry.key]) ? state.versions[entry.key] : []
    list.unshift({ path: versionKey, sha256: previousSha ?? null, size: entry.size, at: new Date().toISOString() })
    while (list.length > keepVersions) {
      const dropped = list.pop()
      if (dropped?.path) {
        try {
          await target.remove(dropped.path)
        } catch (error) {
          log('warn', `清理旧版本失败 ${dropped.path}：${error?.message ?? error}`)
        }
      }
    }
    state.versions[entry.key] = list
    progress.versioned += 1
    return true
  }

  async function uploadFile(target, remoteKey, abs, size) {
    let attempt = 0
    for (;;) {
      try {
        await target.put(remoteKey, abs, size)
        return
      } catch (error) {
        if (error?.retryable === false || attempt >= maxRetries) throw error
        attempt += 1
        log('warn', `上传归档重试（第 ${attempt} 次）：${error?.message ?? error}`)
        await sleep(backoffMs(attempt))
      }
    }
  }

  /**
   * Zip mode: pack the selection into ONE STORE archive and upload that.
   *
   * Unlike mirror mode there is no per-file increment — the whole archive is
   * re-sent — but the remote then holds a self-contained snapshot that opens
   * in Explorer, copies to a NAS, or restores without this plugin. We still
   * skip the upload entirely when the packed bytes are identical to the last
   * archive, so an idle machine stays quiet.
   */
  async function runArchive({ target, entries, trigger, started, local }) {
    progress.phase = 'pack'
    progress.total = entries.length
    const packDir = await mkdtemp(join(tmpdir(), 'dsbk-pack-'))
    const packPath = join(packDir, 'archive.zip')
    try {
      let packedBytes = 0
      const packed = await writeZip(packPath, entries.map((entry) => ({ path: entry.key, abs: entry.abs })), {
        onEntry: (item) => {
          progress.done += 1
          packedBytes += Number(item.size) || 0
        },
      })
      const info = await stat(packPath)
      const sha256 = await sha256File(packPath)
      const stamp = new Date().toISOString().replace('T', '_').replace(/[:.]/g, '-').replace('Z', '')
      const name = `${host}-${stamp}.zip`
      const relativeName = joinKey('archive', name)
      const remoteKey = key(relativeName)

      const previous = await readManifest(target, key(MANIFEST_KEY)).catch(() => undefined)
      const unchanged = previous?.archive?.sha256 === sha256
      progress.phase = 'upload'
      const writeStarted = Date.now()
      if (unchanged) {
        progress.skipped += 1
        log('info', `归档内容与上次完全一致，跳过上传（${formatBytes(info.size)}）`)
      } else {
        await uploadFile(target, remoteKey, packPath, info.size)
        progress.uploaded += 1
        progress.bytes = info.size
        await pace(writeStarted, info.size)
      }

      const createdAt = new Date().toISOString()
      const record = {
        name: relativeName,
        fileName: name,
        size: info.size,
        sha256,
        entries: packed.entries,
        sourceBytes: packedBytes,
        createdAt,
        trigger,
      }
      const list = Array.isArray(state.archive?.list) ? state.archive.list.slice() : []
      if (unchanged && list.length > 0) {
        list[0] = { ...list[0], checkedAt: createdAt }
      } else {
        list.unshift(record)
      }

      progress.phase = 'prune'
      while (list.length > keepArchives) {
        const dropped = list.pop()
        if (dropped?.name === relativeName) break
        try {
          await target.remove(key(dropped.name))
          progress.pruned += 1
        } catch (error) {
          log('warn', `清理旧归档失败 ${dropped?.name}：${error?.message ?? error}`)
        }
      }

      progress.phase = 'manifest'
      state.files = {}
      state.versions = {}
      state.archive = { mode: 'zip', last: unchanged && list.length > 0 ? list[0] : record, list }
      const remote = createManifest(host)
      remote.files = {}
      remote.archive = { ...record, updatedAt: createdAt }
      await writeManifest(target, remote, key(MANIFEST_KEY))

      local.updatedAt = createdAt
      local.lastRun = buildRunRecord(trigger, started, !unchanged)
      local.lastRun.archive = record.name
      local.lastRun.archiveBytes = record.size
      local.history = [local.lastRun, ...(local.history ?? [])].slice(0, historyLimit)
      await saveState(statePath, local)
      progress.phase = 'done'
      return { ok: true, status: snapshot() }
    } finally {
      await rm(packDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  async function run(trigger = 'manual') {
    if (progress.running) return { ok: false, busy: true, status: snapshot() }
    const release = await acquireLock(lockPath)
    if (release === undefined) {
      log('warn', '已有一次备份正在进行，跳过本次触发')
      return { ok: false, busy: true, status: snapshot() }
    }

    progress.running = true
    progress.phase = 'starting'
    progress.trigger = trigger
    progress.startedAt = new Date().toISOString()
    progress.done = 0
    progress.total = 0
    progress.bytes = 0
    progress.uploaded = 0
    progress.skipped = 0
    progress.failed = 0
    progress.excluded = 0
    progress.versioned = 0
    progress.pruned = 0
    progress.toUpload = 0
    progress.errors = []
    progress.skippedByLimit = []
    progress.trees = []

    const started = Date.now()
    const local = ensureState()

    try {
      // Durability barrier: buffered live events are on disk before we read.
      progress.phase = 'flush'
      await flushLiveSessions().catch((error) => log('warn', `刷新活动会话失败：${error?.message ?? error}`))

      progress.phase = 'scan'
      const scanned = await scanSources({ dshHome, scope: options.scope ?? {}, log })
      progress.trees = scanned.trees
      progress.skippedByLimit = scanned.skipped

      const entries = []
      for (const entry of scanned.entries) {
        if (isExcluded(patterns, entry.key)) {
          progress.excluded += 1
          continue
        }
        entries.push(entry)
      }
      progress.total = entries.length

      const target = await targetFactory()
      if (zipMode) return await runArchive({ target, entries, trigger, started, local })
      progress.phase = 'plan'

      let remote = await readManifest(target, key(MANIFEST_KEY)).catch((error) => {
        log('warn', `读取远端清单失败，按全量处理：${error?.message ?? error}`)
        return undefined
      })
      if (remote === undefined) remote = createManifest(host)

      const plan = []
      for (const entry of entries) {
        const known = local.files[entry.key]
        const remoteKnown = remote.files[entry.key]
        if (known !== undefined && known.size === entry.size && known.mtimeMs === entry.mtimeMs && typeof known.sha256 === 'string') {
          progress.skipped += 1
          progress.done += 1
          continue
        }
        if (known !== undefined && known.size === entry.size && remoteKnown !== undefined && remoteKnown.size === entry.size && remoteKnown.sha256 === known.sha256) {
          // Same bytes as last time, only the mtime moved.
          known.mtimeMs = entry.mtimeMs
          progress.skipped += 1
          progress.done += 1
          continue
        }
        plan.push(entry)
      }
      progress.toUpload = plan.length
      progress.phase = 'upload'

      await mapLimit(plan, concurrency, async (entry) => {
        try {
          const sha256 = await sha256File(entry.abs)
          const remoteKnown = remote.files[entry.key]
          if (remoteKnown !== undefined && remoteKnown.sha256 === sha256 && remoteKnown.size === entry.size) {
            local.files[entry.key] = { size: entry.size, mtimeMs: entry.mtimeMs, sha256 }
            progress.skipped += 1
            return
          }
          if (remoteKnown !== undefined && remoteKnown.sha256 !== sha256) {
            await archiveVersion(target, entry, remoteKnown.sha256)
          }
          const writeStarted = Date.now()
          await uploadWithRetry(target, entry)
          local.files[entry.key] = { size: entry.size, mtimeMs: entry.mtimeMs, sha256 }
          remote.files[entry.key] = { sha256, size: entry.size, mtimeMs: entry.mtimeMs, at: new Date().toISOString() }
          progress.uploaded += 1
          progress.bytes += entry.size
          await pace(writeStarted, entry.size)
        } catch (error) {
          recordError(entry, error)
        } finally {
          progress.done += 1
        }
      })

      if (mirrorMode) {
        progress.phase = 'prune'
        const present = new Set(entries.map((entry) => entry.key))
        for (const staleKey of Object.keys(remote.files)) {
          if (present.has(staleKey)) continue
          try {
            await target.remove(key(staleKey))
            delete remote.files[staleKey]
            delete local.files[staleKey]
            progress.pruned += 1
          } catch (error) {
            log('warn', `删除远端多余文件失败 ${staleKey}：${error?.message ?? error}`)
          }
        }
        for (const versionedKey of Object.keys(local.versions)) {
          if (present.has(versionedKey)) continue
          for (const item of local.versions[versionedKey] ?? []) {
            try {
              await target.remove(item.path)
            } catch {
              /* best effort */
            }
          }
          delete local.versions[versionedKey]
        }
      }

      progress.phase = 'manifest'
      remote.host = host
      const digestBefore = manifestDigest(remote)
      await writeManifest(target, remote, key(MANIFEST_KEY))
      const digestAfter = manifestDigest(remote)

      local.updatedAt = new Date().toISOString()
      local.lastRun = buildRunRecord(trigger, started, digestBefore !== digestAfter)
      local.history = [local.lastRun, ...local.history].slice(0, historyLimit)
      await saveState(statePath, local)
      progress.phase = 'done'
      return { ok: progress.failed === 0, status: snapshot() }
    } catch (error) {
      progress.phase = 'failed'
      progress.errors.push({ key: '(run)', message: String(error?.message ?? error) })
      local.lastRun = buildRunRecord(trigger, started, false)
      local.lastRun.ok = false
      local.lastRun.failed = progress.failed + 1
      local.history = [local.lastRun, ...(local.history ?? [])].slice(0, historyLimit)
      await saveState(statePath, local).catch(() => {})
      throw error
    } finally {
      progress.running = false
      if (progress.phase !== 'failed') progress.phase = 'idle'
      await release()
    }
  }

  function buildRunRecord(trigger, started, manifestChanged) {
    return {
      trigger,
      startedAt: progress.startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      ok: progress.failed === 0,
      total: progress.total,
      uploaded: progress.uploaded,
      skipped: progress.skipped,
      failed: progress.failed,
      excluded: progress.excluded,
      versioned: progress.versioned,
      pruned: progress.pruned,
      bytes: progress.bytes,
      bytesLabel: formatBytes(progress.bytes),
      errors: progress.errors.slice(0, MAX_REPORTED_ERRORS),
      skippedByLimit: progress.skippedByLimit.length,
      manifestChanged,
    }
  }

  async function uploadWithRetry(target, entry) {
    let attempt = 0
    for (;;) {
      try {
        await target.put(key(entry.key), entry.abs, entry.size)
        return
      } catch (error) {
        if (error?.retryable === false || attempt >= maxRetries) throw error
        attempt += 1
        log('warn', `上传重试 ${entry.key}（第 ${attempt} 次）：${error?.message ?? error}`)
        await sleep(backoffMs(attempt))
      }
    }
  }

  /** Average-rate pacing: sleep whatever the upload beat the budget by. */
  async function pace(writeStarted, size) {
    if (rateBytesPerSecond <= 0 || size <= 0) return
    const budgetMs = (size / rateBytesPerSecond) * 1000
    const spent = Date.now() - writeStarted
    if (spent < budgetMs) await sleep(Math.min(30000, Math.round(budgetMs - spent)))
  }

  async function probe() {
    const target = await targetFactory()
    return target.probe()
  }

  /**
   * Read a sample of mirrored files back and compare their bytes with the
   * manifest. Time Machine / restic both ship this as "verify"; it is the only
   * check that catches silent server-side corruption.
   */
  async function verify({ sample = 10, only = '' } = {}) {
    const target = await targetFactory()
    const remote = await readManifest(target, key(MANIFEST_KEY))
    if (remote === undefined) throw new Error('远端没有 manifest.json，无法校验')

    // Zip mode verifies the single archive: its bytes and its entry count.
    if (remote.archive?.name !== undefined && Object.keys(remote.files ?? {}).length === 0) {
      const dir = await mkdtemp(join(tmpdir(), 'dsbk-verify-'))
      const archivePath = join(dir, 'archive.zip')
      try {
        const found = await target.getTo(key(remote.archive.name), archivePath)
        if (found === false) {
          return {
            ok: false,
            mode: 'zip',
            totalKeys: 1,
            checked: 0,
            failed: 1,
            errors: [{ key: remote.archive.name, message: '远端归档不存在' }],
            sampledAt: new Date().toISOString(),
          }
        }
        const actual = await sha256File(archivePath)
        const expected = typeof remote.archive.sha256 === 'string' ? remote.archive.sha256 : undefined
        const size = (await stat(archivePath)).size
        const listed = await readZipList(archivePath).catch(() => undefined)
        const errors = []
        if (expected !== undefined && actual !== expected) errors.push({ key: remote.archive.name, message: '归档 SHA-256 与清单不一致' })
        if (listed !== undefined && Number(remote.archive.entries) > 0 && listed.length !== Number(remote.archive.entries)) {
          errors.push({ key: remote.archive.name, message: `归档条目数 ${listed.length} 与清单 ${remote.archive.entries} 不一致` })
        }
        return {
          ok: errors.length === 0,
          mode: 'zip',
          totalKeys: 1,
          checked: 1,
          failed: errors.length,
          errors: errors.slice(0, MAX_REPORTED_ERRORS),
          archive: { name: remote.archive.name, size, sha256: actual, entries: listed?.length ?? null, expectedEntries: Number(remote.archive.entries) || null },
          sampledAt: new Date().toISOString(),
        }
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    }

    const keys = Object.keys(remote.files).filter((entry) => only === '' || entry.startsWith(only)).sort()
    const wanted = Math.max(1, Math.min(200, Number(sample) || 10))
    const picked = []
    if (keys.length <= wanted) picked.push(...keys)
    else {
      const step = keys.length / wanted
      for (let index = 0; index < wanted; index += 1) picked.push(keys[Math.floor(index * step)])
    }
    const dir = await mkdtemp(join(tmpdir(), 'dsbk-verify-'))
    const errors = []
    let checked = 0
    try {
      for (const entry of picked) {
        const info = remote.files[entry]
        const dest = join(dir, `${checked}-${entry.replace(/[^\w.-]+/g, '_')}`)
        try {
          const found = await target.getTo(key(entry), dest)
          if (found === false) throw new Error('远端文件不存在')
          if (typeof info?.sha256 === 'string') {
            const actual = await sha256File(dest)
            if (actual !== info.sha256) throw new Error('SHA-256 与清单不一致')
          }
          checked += 1
        } catch (error) {
          errors.push({ key: entry, message: String(error?.message ?? error) })
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
    return {
      ok: errors.length === 0,
      totalKeys: keys.length,
      checked,
      failed: errors.length,
      errors: errors.slice(0, MAX_REPORTED_ERRORS),
      sampledAt: new Date().toISOString(),
    }
  }

  /**
   * Restore keys back to `dest`. `only` narrows to a key prefix (e.g.
   * `sessions/--D--Project--`). Refuses to write into a live DSH data
   * directory: restoring on top of a running install corrupts sessions.
   */
  async function restore({ dest, only = '', dryRun = false } = {}) {
    const destRoot = String(dest ?? '').trim()
    if (destRoot === '') throw new Error('恢复需要目标目录')
    if (resolvePath(destRoot) === resolvePath(dshHome)) throw new Error('恢复目标不能是正在使用的 DSH 数据目录')
    if (resolvePath(destRoot).startsWith(resolvePath(dshHome) + '\\') || resolvePath(destRoot).startsWith(resolvePath(dshHome) + '/')) {
      throw new Error('恢复目标不能位于正在使用的 DSH 数据目录内')
    }
    const target = await targetFactory()
    const remote = await readManifest(target, key(MANIFEST_KEY))
    if (remote === undefined) throw new Error('远端没有 manifest.json，无法恢复')

    // Zip mode: one archive, extracted as a whole (prefix filter still applies).
    if (remote.archive?.name !== undefined && Object.keys(remote.files ?? {}).length === 0) {
      const total = Number(remote.archive.entries) || 0
      if (dryRun) {
        return {
          ok: true,
          mode: 'zip',
          total,
          restored: 0,
          failed: 0,
          errors: [],
          dryRun,
          dest: destRoot,
          archive: remote.archive.name,
        }
      }
      const dir = await mkdtemp(join(tmpdir(), 'dsbk-restore-'))
      const archivePath = join(dir, 'archive.zip')
      try {
        const found = await target.getTo(key(remote.archive.name), archivePath)
        if (found === false) throw new Error(`远端没有归档 ${remote.archive.name}`)
        if (typeof remote.archive.sha256 === 'string') {
          const actual = await sha256File(archivePath)
          if (actual !== remote.archive.sha256) throw new Error('归档 SHA-256 与清单不一致')
        }
        const result = await extractZip(archivePath, destRoot, { only, verify: true })
        return {
          ok: result.failed === 0,
          mode: 'zip',
          total: result.entries,
          restored: result.extracted,
          failed: result.failed,
          errors: result.errors,
          dryRun,
          dest: destRoot,
          archive: remote.archive.name,
        }
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    }

    const keys = Object.keys(remote.files).sort()
    const selected = only === '' ? keys : keys.filter((entry) => entry.startsWith(only))
    let restored = 0
    let failed = 0
    const errors = []
    for (const entry of selected) {
      const info = remote.files[entry]
      const destAbs = join(destRoot, ...entry.split('/'))
      if (dryRun) {
        restored += 1
        continue
      }
      try {
        const ok = await target.getTo(key(entry), destAbs)
        if (ok === false) throw new Error('远端文件不存在')
        if (typeof info?.sha256 === 'string') {
          const actual = await sha256File(destAbs)
          if (actual !== info.sha256) throw new Error('SHA-256 校验不一致')
        }
        restored += 1
      } catch (error) {
        failed += 1
        if (errors.length < MAX_REPORTED_ERRORS) errors.push({ key: entry, message: String(error?.message ?? error) })
      }
    }
    return { ok: failed === 0, total: selected.length, restored, failed, errors, dryRun, dest: destRoot }
  }

  return { init, status: snapshot, run, probe, verify, restore }
}
