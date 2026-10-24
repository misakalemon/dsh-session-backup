/**
 * WebDAV target (RFC 4918, what Nextcloud / Synology / Alist / 坚果云 expose).
 *
 * Only the four verbs the mirror needs: MKCOL to create collections, PUT to
 * upload, GET to read the manifest, DELETE for pruning. Uploads stream the file
 * instead of buffering it, so a 100 MB attachment costs constant memory.
 */

import { createWriteStream, openAsBlob } from 'node:fs'
import { mkdir, rename, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { assertInside, backoffMs, sleep } from './util.js'

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504])

function encodePath(path) {
  return path
    .split('/')
    .filter((part) => part !== '')
    .map((part) => encodeURIComponent(part))
    .join('/')
}

export function createWebdavTarget(spec, log = () => {}) {
  const base = String(spec.url ?? '').trim().replace(/\/+$/, '')
  if (base === '') throw new Error('webdav 目标需要 url')
  if (!/^https?:\/\//i.test(base)) throw new Error('WebDAV 地址必须以 http:// 或 https:// 开头')

  const baseUrl = new URL(base)
  const originUrl = baseUrl.origin
  const basePath = baseUrl.pathname.replace(/^\/+/, '')

  /**
   * The pasted URL is normally the folder *inside* a WebDAV mount, but a lot of
   * servers host the endpoint under a prefix (`/webdav`, `/dav`, `/remote.php/dav`).
   * When the folder itself answers 404 we look for such a prefix at the origin and
   * adopt the first one that exists, so `https://host/backup` still finds
   * `https://host/webdav/backup` instead of failing with an opaque 409.
   */
  const KNOWN_DAV_ROOTS = ['webdav', 'dav', 'remote.php/dav']
  let activeBase = base
  let basePromise = null
  let moveUnsupported = false

  const username = String(spec.username ?? '')
  const password = String(spec.password ?? '')
  const timeoutMs = Math.max(1000, Number(spec.timeoutMs ?? 30000))
  // rclone / Alist create collections lazily and can sit on a MKCOL for far
  // longer than a normal request, so directory setup gets its own budget.
  const dirTimeoutMs = Math.max(timeoutMs, 120000)

  const headers = {}
  if (username !== '' || password !== '') {
    headers.authorization = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
  }

  async function request(method, path, { body, headers: extra, attempts = 3, allow = [], fromOrigin = false, timeout } = {}) {
    const url = fromOrigin ? `${originUrl}/${encodePath(path)}` : `${activeBase}/${encodePath(path)}`
    const limit = Math.max(1000, Number(timeout ?? timeoutMs))
    let lastError
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), limit)
      try {
        const response = await fetch(url, {
          method,
          headers: { ...headers, ...(extra ?? {}) },
          body,
          signal: controller.signal,
          duplex: body === undefined ? undefined : 'half',
        })
        if (response.ok || allow.includes(response.status)) {
          const text = method === 'GET' ? await response.text() : ''
          return { status: response.status, text }
        }
        if (response.status === 401 || response.status === 403) {
          const error = new Error(`WebDAV 认证失败（${response.status}）：请检查用户名与密码`)
          error.code = 'EACCES'
          error.retryable = false
          throw error
        }
        const hint =
          response.status === 404
            ? `（路径不存在：如果服务端把 WebDAV 挂在 /webdav 之类的前缀下，地址里要带上它；当前解析到的根是 ${activeBase}）`
            : response.status === 409
              ? '（服务器认为目标集合不存在或不允许建父级目录，检查地址是否指向一个已存在/可创建的目录）'
              : response.status === 507
                ? '（空间不足）'
                : response.status === 423
                  ? '（资源被锁定）'
                  : ''
        const error = new Error(`WebDAV ${method} ${path} 返回 ${response.status}${hint}`)
        error.status = response.status
        error.retryable = RETRYABLE.has(response.status)
        throw error
      } catch (error) {
        lastError = error
        const aborted = error?.name === 'AbortError'
        const retryable = aborted || error?.retryable === true
        if (!retryable || attempt === attempts) {
          if (aborted) throw new Error(`WebDAV 请求超时（${limit} ms）：${method} ${path}`)
          throw error
        }
        await sleep(backoffMs(attempt))
      } finally {
        clearTimeout(timer)
      }
    }
    throw lastError ?? new Error(`WebDAV ${method} ${path} 失败`)
  }

  /** PROPFIND status of one absolute URL; 0 when the network itself failed. */
  async function propfindStatus(url, depth = '0') {
    try {
      const response = await fetch(url, {
        method: 'PROPFIND',
        headers: { ...headers, depth },
        signal: AbortSignal.timeout(timeoutMs),
      })
      await response.arrayBuffer().catch(() => undefined)
      return response.status
    } catch {
      return 0
    }
  }

  /** Collection names listed at the origin root (used to spot a WebDAV prefix). */
  async function listOriginCollections() {
    try {
      const response = await fetch(`${originUrl}/`, {
        method: 'PROPFIND',
        headers: { ...headers, depth: '1' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (response.status !== 207) return []
      const text = await response.text()
      const names = []
      for (const match of text.matchAll(/<d:href>([^<]+)<\/d:href>/gi)) {
        let href = match[1]
        try {
          href = decodeURIComponent(href)
        } catch {
          /* keep the raw form */
        }
        const name = href.replace(/^https?:\/\/[^/]+/i, '').replace(/^\/+|\/+$/g, '')
        if (name !== '' && !name.includes('/')) names.push(name)
      }
      return names
    } catch {
      return []
    }
  }

  /**
   * Work out which absolute base to talk to. Stays as configured whenever the
   * folder already exists; otherwise looks for a WebDAV prefix at the origin and
   * adopts the first candidate that answers PROPFIND without an error.
   */
  function resolveBase() {
    if (basePromise === null) {
      basePromise = (async () => {
        const status = await propfindStatus(activeBase, '0')
        if (status === 207 || status === 200 || status === 401 || status === 403) return
        if (basePath === '') return
        const candidates = [...KNOWN_DAV_ROOTS]
        for (const name of await listOriginCollections()) {
          if (/dav/i.test(name) && !candidates.includes(name)) candidates.push(name)
        }
        for (const prefix of candidates) {
          const candidate = `${originUrl}/${prefix}/${basePath}`
          if ((await propfindStatus(candidate, '0')) === 207) {
            activeBase = candidate
            log('info', `[session-backup] WebDAV 根路径自动补全：${base} → ${candidate}`)
            return
          }
        }
      })().catch(() => undefined)
    }
    return basePromise
  }

  /**
   * The configured URL is a *destination* (e.g. https://host/DSH/backup), and
   * a WebDAV server answers MKCOL/PUT below it with 409 Conflict while that
   * collection is missing. People routinely point us at a folder they have not
   * created yet, so on a 409 we create the base path ourselves (shallowest first)
   * and try once more. Servers that mount their root at that path answer 404/405
   * for the ancestors — that is expected and not an error; the retried operation
   * reports the real problem.
   */
  const created = new Set()
  let baseReady = false
  let dirChain = Promise.resolve()
  async function ensureBaseCollections() {
    if (baseReady) return
    // Verify before creating. The configured URL is a destination that normally
    // already exists, and aggregate backends (union/combine mounts) reject a
    // blind MKCOL at their virtual root with 409 — which used to turn one slow
    // upload into "create the whole world" nonsense.
    const status = await propfindStatus(activeBase, '0')
    if (status === 207 || status === 200) {
      baseReady = true
      return
    }
    if (status === 401 || status === 403) {
      throw new Error(`WebDAV 目标目录不可访问（HTTP ${status}）：${activeBase}`)
    }
    const segments = new URL(activeBase).pathname.split('/').filter((part) => part !== '')
    let path = ''
    for (const segment of segments) {
      path = path === '' ? segment : `${path}/${segment}`
      if (created.has(path)) continue
      await request('MKCOL', path, { allow: [301, 302, 404, 405, 409], attempts: 3, fromOrigin: true, timeout: dirTimeoutMs })
      created.add(path)
    }
    baseReady = true
  }

  /** Run `fn`, and on a 409 build the destination path before one retry. */
  async function afterBaseFix(fn) {
    try {
      return await fn()
    } catch (error) {
      if (error?.status !== 409) throw error
      await ensureBaseCollections()
      return await fn()
    }
  }

  /** MKCOL every ancestor, shallowest first; "already exists" is success. */
  async function ensureCollections(key) {
    // Serialised on purpose: a parallel upload round would otherwise fire the
    // same MKCOL from every worker and the slow backend answers most of them
    // with a 30s timeout.
    const run = async () => {
      const segments = key.split('/').slice(0, -1)
      let prefix = ''
      for (const segment of segments) {
        prefix = prefix === '' ? segment : `${prefix}/${segment}`
        if (created.has(prefix)) continue
        await afterBaseFix(async () => {
          await request('MKCOL', prefix, { allow: [405, 301], attempts: 3, timeout: dirTimeoutMs })
        })
        created.add(prefix)
      }
    }
    const next = dirChain.then(run, run)
    dirChain = next.catch(() => undefined)
    await next
  }

  async function put(key, absPath, size) {
    assertInside('', key)
    await resolveBase()
    const blob = await openAsBlob(absPath)
    await afterBaseFix(async () => {
      await ensureCollections(key)
      await request('PUT', key, {
        body: blob,
        headers: { 'content-length': String(size ?? blob.size), 'content-type': 'application/octet-stream' },
        attempts: 3,
      })
    })
  }

  async function putText(key, text) {
    await resolveBase()
    await afterBaseFix(async () => {
      await ensureCollections(key)
      await request('PUT', key, {
        // A Blob can be re-read by the retry loop; a consumed ReadableStream
        // cannot, and undici answers that with "Response body object should
        // not be disturbed or locked".
        body: new Blob([Buffer.from(text, 'utf8')]),
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        attempts: 3,
      })
    })
  }

  /**
   * Fallback for servers without MOVE: download the old copy into a temp file,
   * then upload it back. Staging to disk (instead of piping the GET body
   * straight into the PUT) keeps retries possible and costs nothing in memory.
   */
  async function copyByStream(from, to) {
    const staged = join(tmpdir(), `dsh-backup-copy-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`)
    try {
      const source = await fetch(`${activeBase}/${encodePath(from)}`, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (source.status === 404) {
        const error = new Error(`WebDAV 源文件不存在：${from}`)
        error.retryable = false
        throw error
      }
      if (!source.ok) throw new Error(`WebDAV GET ${from} 返回 ${source.status}`)
      await pipeline(Readable.fromWeb(source.body), createWriteStream(staged))
      const blob = await openAsBlob(staged)
      await request('PUT', to, {
        body: blob,
        headers: { 'content-type': 'application/octet-stream' },
        attempts: 3,
      })
    } finally {
      await unlink(staged).catch(() => undefined)
    }
  }

  return {
    kind: 'webdav',
    label: 'WebDAV',
    get address() {
      return activeBase
    },

    put,
    putText,

    async getText(key) {
      await resolveBase()
      // Control-plane reads (the manifest) are small but the backend can stall
      // on them right after a cold start, so they share the MKCOL budget.
      const result = await request('GET', key, { allow: [404], attempts: 3, timeout: dirTimeoutMs })
      if (result.status === 404) return undefined
      return result.text
    },

    /** Restore: stream one mirrored file back out to `destAbs`. */
    async getTo(key, destAbs) {
      await resolveBase()
      const url = `${activeBase}/${encodePath(key)}`
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
      if (response.status === 404) return false
      if (!response.ok) throw new Error(`WebDAV GET ${key} 返回 ${response.status}`)
      await mkdir(dirname(destAbs), { recursive: true })
      const tmp = `${destAbs}.part-${process.pid}`
      await pipeline(Readable.fromWeb(response.body), createWriteStream(tmp))
      await rename(tmp, destAbs)
      return true
    },

    async remove(key) {
      await resolveBase()
      await request('DELETE', key, { allow: [404], attempts: 2 })
    },

    /** Versioning: move the current copy aside before it is overwritten. */
    /**
     * Versioning: put a copy of the current bytes at `to` before the original is
     * overwritten. RFC MOVE is the cheap way; servers that proxy to a backend
     * without rename (rclone serve webdav is one) answer 405/501/502, so we fall
     * back to GET -> PUT streaming and remember that for the rest of the round.
     */
    async move(from, to) {
      assertInside('', from)
      assertInside('', to)
      await resolveBase()
      await ensureCollections(to)
      if (!moveUnsupported) {
        const destination = new URL(`${activeBase}/${encodePath(to)}`)
        try {
          const result = await request('MOVE', from, {
            headers: { destination: destination.toString(), overwrite: 'T' },
            allow: [201, 204, 301, 302],
            attempts: 1,
          })
          return { mode: result.status === 0 ? 'copy' : 'move' }
        } catch (error) {
          if (error?.status === 404) {
            const missing = new Error(`WebDAV MOVE 源文件不存在：${from}`)
            missing.retryable = false
            throw missing
          }
          if (![403, 405, 409, 501, 502].includes(error?.status)) throw error
          moveUnsupported = true
          log('warn', `[session-backup] 服务端不支持 MOVE（${error.status}），改用下载+重传保存旧版本`)
        }
      }
      await copyByStream(from, to)
      return { mode: 'copy' }
    },

    async probe() {
      await resolveBase()
      const stamp = new Date().toISOString()
      // A single file directly in the destination: proves the same things as a
      // nested probe (reachability, auth, MKCOL when needed, PUT, GET, DELETE)
      // while assuming nothing about the remote layout.
      const key = `.probe-${process.pid}-${Date.now()}.txt`
      await putText(key, stamp)
      try {
        const readBack = await this.getText(key)
        if (String(readBack ?? '').trim() !== stamp) throw new Error('WebDAV 写入后读回内容不一致')
      } finally {
        await this.remove(key)
      }
      const note = activeBase === base ? '' : `（地址已自动补全为 ${activeBase}）`
      return { ok: true, detail: `可写：${activeBase}${note}` }
    },
  }
}
