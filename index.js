/**
 * Session Remote Backup — host half.
 *
 * Mirrors `${DSH_HOME}/sessions`, `attachments` and `storages` to a remote
 * target (WebDAV first, directory/UNC too, more adapters pluggable through
 * `lib/targets.js`). Runs:
 *   - after a turn ends (debounced), so a finished conversation is protected
 *   - on a schedule: every N minutes, or daily at a fixed local time
 *   - shortly after startup, to pick up whatever changed while DSH was closed
 *   - on demand from the settings page or `POST /session-backup/api/run`
 *
 * Design constraints that shaped this file:
 *   - The persistence service exposes no raw bytes and no deletion API, so the
 *     mirror is built from the files themselves, and pruning is opt-in.
 *   - Nothing outside `node:*` is imported: the plugin is installed with
 *     `link:`, where the profile's node_modules is not on the resolution path,
 *     so no `@deepseek-ai/*` package (in particular no schemastery `Config`)
 *     may be imported. Settings therefore live in our own panel and are
 *     persisted to `<stateDir>/config.json`.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, hostname } from 'node:os'
import { createEngine } from './lib/engine.js'
import { createTarget } from './lib/targets.js'
import { joinKey } from './lib/util.js'

export const name = 'session-backup'

/** Everything is resolved lazily: a missing optional service degrades, never throws. */
export const inject = []

const API_PREFIX = '/session-backup/api'
const API_BODY_MAX = 64 * 1024
const TICK_MS = 30000

const DEFAULTS = {
  enabled: true,
  paused: false,
  target: 'webdav',
  prefix: '',
  remote: {
    url: '',
    root: '',
    username: '',
    usernameRef: 'DSH_BACKUP_USERNAME',
    passwordRef: 'DSH_BACKUP_PASSWORD',
    timeoutSeconds: 30,
  },
  scope: {
    sessions: true,
    attachments: true,
    storages: true,
    maxAttachmentMB: 64,
    maxFileMB: 512,
  },
  schedule: {
    mode: 'interval',
    intervalMinutes: 30,
    dailyAt: '03:00',
    onTurnEnd: true,
    debounceMs: 20000,
    onStartup: true,
    startupDelayMinutes: 3,
  },
  transfer: {
    concurrency: 2,
    retries: 2,
    bandwidthKBps: 0,
  },
  versions: {
    keep: 0,
  },
  // 'mirror' uploads one object per file (incremental); 'zip' uploads a single
  // self-contained archive per run (re-sent in full when anything changed).
  archiveMode: 'mirror',
  archiveKeep: 3,
  exclude: [],
  deleteMode: 'archive',
  verifyAfter: false,
  verifySample: 10,
  stateDir: '',
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && Array.isArray(value) === false
}

function merge(base, patch) {
  const out = { ...base }
  if (!isPlainObject(patch)) return out
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? merge(base[key], value) : value
  }
  return out
}

function toInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.round(parsed)))
}

function parseDailyAt(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (match === null) return { hours: 3, minutes: 0 }
  return {
    hours: Math.max(0, Math.min(23, Number(match[1]))),
    minutes: Math.max(0, Math.min(59, Number(match[2]))),
  }
}

export function apply(ctx, config) {
  const loaderConfig = config ?? {}
  let options = merge(DEFAULTS, loaderConfig)

  const log = (level, message) => {
    const fn = level === 'warn' ? ctx.logger?.warn : ctx.logger?.info
    const text = `[session-backup] ${message}`
    if (typeof fn === 'function') fn.call(ctx.logger, text)
    else if (level === 'warn') console.warn(text)
    else console.info(text)
  }

  const homeDir = String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
  const host = hostname() || 'unknown-host'

  const resolveStateDir = (current) => String(current?.stateDir ?? '').trim() || join(homeDir, 'session-backup')
  let stateDir = resolveStateDir(options)
  const settingsPath = () => join(stateDir, 'config.json')

  function loadSaved() {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath(), 'utf8'))
      if (isPlainObject(parsed)) return parsed
    } catch {
      /* no saved overrides yet, or unreadable — the loader config stands */
    }
    return {}
  }

  function persistSaved(next) {
    mkdirSync(stateDir, { recursive: true })
    const tmp = `${settingsPath()}.tmp`
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, settingsPath())
  }

  let saved = loadSaved()
  options = merge(merge(DEFAULTS, loaderConfig), saved)
  stateDir = resolveStateDir(options)

  let prefix = String(options.prefix ?? '').trim() || joinKey('dsh-session-backup', host)

  if (options.enabled === false) return

  async function flushLiveSessions() {
    // `sessions.flush` is the durability barrier documented by the session
    // store; the persistence service exposes a service-wide flush as well.
    const flushed = []
    const sessions = ctx.get('sessions')
    if (sessions !== undefined && typeof sessions.list === 'function') {
      for (const session of sessions.list()) {
        try {
          await sessions.flush?.(session)
          flushed.push(session?.id)
        } catch (error) {
          log('warn', `刷新会话失败：${error?.message ?? error}`)
        }
      }
    }
    const persistence = ctx.get('sessionPersistence')
    if (typeof persistence?.flush === 'function') {
      try {
        await persistence.flush()
      } catch (error) {
        log('warn', `刷新持久化层失败：${error?.message ?? error}`)
      }
    }
    return flushed
  }

  async function resolveSecret(ref, fallback) {
    const target = String(ref ?? '').trim()
    if (target !== '') {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined && typeof credentials.resolve === 'function') {
        try {
          const resolved = await credentials.resolve(target)
          const value = typeof resolved === 'string' ? resolved : resolved?.value
          if (typeof value === 'string' && value !== '') return value
        } catch (error) {
          log('warn', `读取凭据 ${target} 失败：${error?.message ?? error}`)
        }
      }
    }
    return fallback
  }

  const isConfigured = () => {
    const kind = String(options.target ?? 'webdav').trim().toLowerCase()
    if (kind === 'dir') return String(options.remote?.root ?? '').trim() !== ''
    return String(options.remote?.url ?? '').trim() !== ''
  }

  const isPaused = () => options.paused === true

  async function currentTarget() {
    const kind = String(options.target ?? 'webdav').trim().toLowerCase()
    if (kind === 'dir') return createTarget({ kind, root: options.remote.root })
    return createTarget({
      kind: 'webdav',
      url: options.remote.url,
      username: await resolveSecret(options.remote.usernameRef, options.remote.username),
      password: await resolveSecret(options.remote.passwordRef, ''),
      timeoutMs: Math.max(5, Number(options.remote.timeoutSeconds) || 30) * 1000,
    })
  }

  // Rebuilt whenever the panel saves new settings: prefix, caps and the retry /
  // versioning policy are baked into the engine at construction time.
  let engine = null
  function buildEngine() {
    engine = createEngine({
      dshHome: homeDir,
      host,
      prefix,
      statePath: join(stateDir, 'state.json'),
      lockPath: join(stateDir, 'backup.lock'),
      stateDir,
      scope: options.scope,
      deleteMode: String(options.deleteMode ?? 'archive').toLowerCase() === 'mirror' ? 'mirror' : 'archive',
      exclude: Array.isArray(options.exclude) ? options.exclude : [],
      concurrency: toInt(options.transfer?.concurrency, 2, 1, 4),
      retries: toInt(options.transfer?.retries, 2, 0, 5),
      bandwidthKBps: toInt(options.transfer?.bandwidthKBps, 0, 0, 1000000),
      versionsKeep: toInt(options.versions?.keep, 0, 0, 50),
      archiveMode: String(options.archiveMode ?? 'mirror').toLowerCase() === 'zip' ? 'zip' : 'mirror',
      archiveKeep: toInt(options.archiveKeep, 3, 1, 50),
      log,
      flushLiveSessions,
      targetFactory: currentTarget,
    })
    void engine.init().catch((error) => log('warn', `读取本地状态失败：${error?.message ?? error}`))
  }
  buildEngine()

  let lastVerify = null

  /** One run plus the optional read-back verification mature tools offer. */
  async function runBackup(trigger) {
    const result = await engine.run(trigger)
    if (options.verifyAfter === true && result?.ok !== false) {
      try {
        lastVerify = await engine.verify({ sample: toInt(options.verifySample, 10, 1, 200) })
        if (lastVerify.ok !== true) log('warn', `备份后校验发现 ${lastVerify.failed} 个文件与清单不一致`)
      } catch (error) {
        log('warn', `备份后校验失败：${error?.message ?? error}`)
      }
    }
    return result
  }

  // ---- schedule ------------------------------------------------------------

  const timer = ctx.get('timer')
  const interval = (fn, ms) => {
    if (typeof timer?.interval === 'function') return timer.interval(fn, ms)
    const handle = setInterval(fn, ms)
    return () => clearInterval(handle)
  }
  const timeout = (fn, ms) => {
    if (typeof timer?.timeout === 'function') return timer.timeout(fn, ms)
    const handle = setTimeout(fn, ms)
    return () => clearTimeout(handle)
  }

  let nextRunAt = null

  function computeNextRun(now = Date.now()) {
    if (isPaused()) return null
    const mode = String(options.schedule?.mode ?? 'interval').toLowerCase()
    if (mode === 'daily') {
      const { hours, minutes } = parseDailyAt(options.schedule?.dailyAt)
      const next = new Date(now)
      next.setHours(hours, minutes, 0, 0)
      if (next.getTime() <= now) next.setDate(next.getDate() + 1)
      return next.toISOString()
    }
    if (mode === 'interval') {
      const minutes = toInt(options.schedule?.intervalMinutes, 0, 0, 10080)
      if (minutes <= 0) return null
      return new Date(now + minutes * 60000).toISOString()
    }
    return null
  }

  function refreshNextRun() {
    nextRunAt = computeNextRun()
  }
  refreshNextRun()

  let dirty = false
  let dirtyAt = 0

  const disposers = []

  // Turn-end trigger: debounced, so a burst of tool calls costs one backup.
  disposers.push(interval(() => {
    if (isPaused() || !dirty) return
    if (!isConfigured()) return
    if (Date.now() - dirtyAt < toInt(options.schedule?.debounceMs, 20000, 1000, 600000)) return
    dirty = false
    void runBackup('turn-end').catch((error) => log('warn', `回合后备份失败：${error?.message ?? error}`))
  }, 5000))

  // Schedule tick: also keeps `nextRunAt` honest after a pause or a clock change.
  disposers.push(interval(() => {
    if (isPaused()) {
      nextRunAt = null
      return
    }
    if (!isConfigured()) {
      nextRunAt = null
      return
    }
    const due = nextRunAt === null ? false : Date.now() >= Date.parse(nextRunAt)
    if (!due) {
      if (nextRunAt === null) refreshNextRun()
      return
    }
    nextRunAt = computeNextRun()
    if (engine.status().running === true) return
    void runBackup('schedule').catch((error) => log('warn', `定时备份失败：${error?.message ?? error}`))
  }, TICK_MS))

  if (options.schedule?.onStartup !== false) {
    const startupMinutes = toInt(options.schedule?.startupDelayMinutes, 3, 0, 1440)
    disposers.push(timeout(() => {
      if (isPaused()) return
      if (!isConfigured()) {
        log('info', '还没有配置备份目标，自动备份暂不启动')
        return
      }
      void runBackup('startup').catch((error) => log('warn', `启动备份失败：${error?.message ?? error}`))
    }, startupMinutes * 60000))
  }

  if (options.schedule?.onTurnEnd !== false) {
    ctx.on('session/event', (session, event) => {
      if (event?.type !== 'turn/end') return
      if (isPaused()) return
      dirty = true
      dirtyAt = Date.now()
      void session
    })
  }

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose?.()
      } catch {
        /* disposal is best effort */
      }
    }
  }, 'session-backup: timers')

  // ---- management API -----------------------------------------------------

  function sendJson(res, status, body) {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
    })
    res.end(payload)
  }

  async function readBody(req) {
    let size = 0
    const chunks = []
    for await (const chunk of req) {
      size += chunk.length
      if (size > API_BODY_MAX) throw new Error('请求体过大')
      chunks.push(chunk)
    }
    if (size === 0) return {}
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw new Error('请求体不是合法 JSON')
    }
  }

  async function saveSecret(ref, value) {
    const target = String(ref ?? '').trim()
    if (target === '' || typeof value !== 'string' || value === '') return false
    const credentials = ctx.get('credentials')
    if (credentials === undefined || typeof credentials.set !== 'function') return false
    try {
      await credentials.set(target, value)
      return true
    } catch (error) {
      log('warn', `保存凭据 ${target} 失败：${error?.message ?? error}`)
      return false
    }
  }

  async function hasSecret(ref) {
    const target = String(ref ?? '').trim()
    if (target === '') return false
    const credentials = ctx.get('credentials')
    if (credentials === undefined || typeof credentials.resolve !== 'function') return false
    try {
      const resolved = await credentials.resolve(target)
      const value = typeof resolved === 'string' ? resolved : resolved?.value
      return typeof value === 'string' && value !== ''
    } catch {
      return false
    }
  }

  function publicSettings() {
    return {
      target: String(options.target ?? 'webdav').trim().toLowerCase(),
      url: String(options.remote?.url ?? ''),
      root: String(options.remote?.root ?? ''),
      prefix,
      timeoutSeconds: Number(options.remote?.timeoutSeconds) || 30,
      paused: isPaused(),
      scope: { ...options.scope },
      schedule: { ...options.schedule },
      transfer: { ...options.transfer },
      versions: { ...options.versions },
      archiveMode: String(options.archiveMode ?? 'mirror').toLowerCase() === 'zip' ? 'zip' : 'mirror',
      archiveKeep: toInt(options.archiveKeep, 3, 1, 50),
      exclude: Array.isArray(options.exclude) ? [...options.exclude] : [],
      deleteMode: String(options.deleteMode ?? 'archive').toLowerCase(),
      verifyAfter: options.verifyAfter === true,
      verifySample: toInt(options.verifySample, 10, 1, 200),
      stateDir,
      settingsPath: settingsPath(),
    }
  }

  function applyBodyToSaved(body, next) {
    const nextRemote = { ...(next.remote ?? {}) }
    const nextScope = { ...(next.scope ?? {}) }
    const nextSchedule = { ...(next.schedule ?? {}) }
    const nextTransfer = { ...(next.transfer ?? {}) }
    const nextVersions = { ...(next.versions ?? {}) }

    if (typeof body.target === 'string' && body.target.trim() !== '') next.target = body.target.trim().toLowerCase()
    if (typeof body.prefix === 'string') next.prefix = body.prefix.trim()
    if (typeof body.url === 'string') nextRemote.url = body.url.trim()
    if (typeof body.root === 'string') nextRemote.root = body.root.trim()
    if (body.timeoutSeconds !== undefined) nextRemote.timeoutSeconds = toInt(body.timeoutSeconds, 30, 5, 600)

    const scopeBody = isPlainObject(body.scope) ? body.scope : body
    for (const key of ['sessions', 'attachments', 'storages']) {
      if (scopeBody[key] !== undefined) nextScope[key] = scopeBody[key] === true
    }
    if (scopeBody.maxAttachmentMB !== undefined) nextScope.maxAttachmentMB = toInt(scopeBody.maxAttachmentMB, 64, 0, 4096)
    if (scopeBody.maxFileMB !== undefined) nextScope.maxFileMB = toInt(scopeBody.maxFileMB, 512, 0, 65536)

    if (typeof body.exclude === 'string') {
      next.exclude = body.exclude
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '')
    } else if (Array.isArray(body.exclude)) {
      next.exclude = body.exclude.map((line) => String(line).trim()).filter((line) => line !== '')
    }
    if (typeof body.deleteMode === 'string') {
      const mode = body.deleteMode.trim().toLowerCase()
      next.deleteMode = mode === 'mirror' ? 'mirror' : 'archive'
    }
    if (typeof body.archiveMode === 'string') {
      next.archiveMode = body.archiveMode.trim().toLowerCase() === 'zip' ? 'zip' : 'mirror'
    }
    if (body.archiveKeep !== undefined) next.archiveKeep = toInt(body.archiveKeep, 3, 1, 50)
    if (body.versionsKeep !== undefined) nextVersions.keep = toInt(body.versionsKeep, 0, 0, 50)
    if (body.verifyAfter !== undefined) next.verifyAfter = body.verifyAfter === true
    if (body.verifySample !== undefined) next.verifySample = toInt(body.verifySample, 10, 1, 200)
    if (body.paused !== undefined) next.paused = body.paused === true

    const transferBody = isPlainObject(body.transfer) ? body.transfer : body
    if (transferBody.concurrency !== undefined) nextTransfer.concurrency = toInt(transferBody.concurrency, 2, 1, 4)
    if (transferBody.retries !== undefined) nextTransfer.retries = toInt(transferBody.retries, 2, 0, 5)
    if (transferBody.bandwidthKBps !== undefined) nextTransfer.bandwidthKBps = toInt(transferBody.bandwidthKBps, 0, 0, 1000000)

    const scheduleBody = isPlainObject(body.schedule) ? body.schedule : body
    if (typeof scheduleBody.mode === 'string') {
      const mode = scheduleBody.mode.trim().toLowerCase()
      nextSchedule.mode = mode === 'daily' || mode === 'off' ? mode : 'interval'
    }
    if (scheduleBody.intervalMinutes !== undefined) nextSchedule.intervalMinutes = toInt(scheduleBody.intervalMinutes, 30, 0, 10080)
    if (typeof scheduleBody.dailyAt === 'string') {
      const { hours, minutes } = parseDailyAt(scheduleBody.dailyAt)
      nextSchedule.dailyAt = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
    }
    if (scheduleBody.onTurnEnd !== undefined) nextSchedule.onTurnEnd = scheduleBody.onTurnEnd === true
    if (scheduleBody.onStartup !== undefined) nextSchedule.onStartup = scheduleBody.onStartup === true
    if (scheduleBody.debounceMs !== undefined) nextSchedule.debounceMs = toInt(scheduleBody.debounceMs, 20000, 1000, 600000)
    if (scheduleBody.startupDelayMinutes !== undefined) {
      nextSchedule.startupDelayMinutes = toInt(scheduleBody.startupDelayMinutes, 3, 0, 1440)
    }

    next.remote = nextRemote
    next.scope = nextScope
    next.schedule = nextSchedule
    next.transfer = nextTransfer
    next.versions = nextVersions
    return next
  }

  async function handleApiRequest(req, res) {
    const route = String(req.url ?? '').split('?')[0].slice(API_PREFIX.length).replace(/^\/+/, '')
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: { message: '只支持 POST' } })
      return
    }
    try {
      const body = await readBody(req)

      if (route === 'status') {
        sendJson(res, 200, {
          ok: true,
          value: {
            ...engine.status(),
            configured: isConfigured(),
            paused: isPaused(),
            host,
            prefix,
            nextRunAt,
            lastVerify,
            settings: publicSettings(),
            hasUsername: await hasSecret(options.remote?.usernameRef),
            hasPassword: await hasSecret(options.remote?.passwordRef),
          },
        })
        return
      }

      if (route === 'saveConfig') {
        if (engine.status().running === true) throw new Error('备份正在进行，等这次跑完再改设置')
        const next = applyBodyToSaved(body, { ...saved })

        persistSaved(next)
        saved = next
        options = merge(merge(DEFAULTS, loaderConfig), saved)
        stateDir = resolveStateDir(options)
        prefix = String(options.prefix ?? '').trim() || joinKey('dsh-session-backup', host)

        const usernameSaved = await saveSecret(options.remote?.usernameRef, typeof body.username === 'string' ? body.username : '')
        const passwordSaved = await saveSecret(options.remote?.passwordRef, typeof body.password === 'string' ? body.password : '')
        buildEngine()
        refreshNextRun()
        log('info', `设置已更新：${isConfigured() ? '已配置目标' : '尚未配置目标'}${isPaused() ? '（自动备份已暂停）' : ''}`)
        sendJson(res, 200, {
          ok: true,
          value: { settings: publicSettings(), configured: isConfigured(), paused: isPaused(), usernameSaved, passwordSaved },
        })
        return
      }

      if (route === 'pause') {
        const next = { ...saved, paused: body?.paused === true }
        persistSaved(next)
        saved = next
        options = merge(merge(DEFAULTS, loaderConfig), saved)
        refreshNextRun()
        log('info', isPaused() ? '自动备份已暂停（手动备份仍可用）' : '自动备份已恢复')
        sendJson(res, 200, { ok: true, value: { paused: isPaused(), nextRunAt } })
        return
      }

      if (route === 'run') {
        if (!isConfigured()) throw new Error('还没有配置备份目标：请先在面板里填写服务器地址')
        if (engine.status().running === true) throw new Error('备份已经在进行中')
        // Fire and forget: the page polls `status` for progress.
        void runBackup('manual').catch((error) => log('warn', `手动备份失败：${error?.message ?? error}`))
        sendJson(res, 200, { ok: true, value: { started: true } })
        return
      }

      if (route === 'probe') {
        const result = await engine.probe()
        sendJson(res, 200, { ok: true, value: result })
        return
      }

      if (route === 'verify') {
        if (!isConfigured()) throw new Error('还没有配置备份目标')
        const result = await engine.verify({ sample: body?.sample, only: body?.only ?? '' })
        sendJson(res, 200, { ok: true, value: result })
        return
      }

      if (route === 'restore') {
        const result = await engine.restore({ dest: body?.dest, only: body?.only ?? '', dryRun: body?.dryRun === true })
        sendJson(res, 200, { ok: true, value: result })
        return
      }

      sendJson(res, 404, { ok: false, error: { message: `未知操作 ${route}` } })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: { message: String(error?.message ?? error) } })
    }
  }

  ctx.inject(['connection', 'webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'prefix',
          path: API_PREFIX,
          handler: (req, res) => handleApiRequest(req, res),
        }),
      'session-backup: management api',
    )
  })
}
