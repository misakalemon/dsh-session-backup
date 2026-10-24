/**
 * Small helpers shared by the host-side backup modules.
 *
 * Everything here is pure Node: the plugin is installed with `link:`, so the
 * profile's node_modules is not on our resolution path and no
 * `@deepseek-ai/*` package may be imported.
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

/** Hash a file without buffering it in memory. */
export async function sha256File(absPath) {
  const hash = createHash('sha256')
  const stream = createReadStream(absPath, { highWaterMark: 1 << 20 })
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

export function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Windows separators → `/`, so remote keys are stable across platforms. */
export function toPosix(value) {
  return String(value).split(sep).join('/')
}

/** Relative key of `absPath` under `root`, in posix form. */
export function relKey(root, absPath) {
  return toPosix(relative(root, absPath))
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
  return dir
}

export async function fileStat(absPath) {
  try {
    const info = await stat(absPath)
    if (!info.isFile()) return undefined
    return { size: info.size, mtimeMs: Math.floor(info.mtimeMs) }
  } catch {
    return undefined
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Exponential backoff with a little jitter; `attempt` is 1-based. */
export function backoffMs(attempt, base = 400, cap = 15000) {
  const raw = Math.min(cap, base * 2 ** Math.max(0, attempt - 1))
  return raw + Math.floor(Math.random() * (raw / 4 + 1))
}

export function joinKey(...parts) {
  return parts
    .filter((part) => part !== undefined && part !== null && String(part) !== '')
    .map((part) => String(part).replace(/^\/+|\/+$/g, ''))
    .filter((part) => part !== '')
    .join('/')
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = value / 1024
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[index]}`
}

/** Guard against `..` escaping whatever root a target was given. */
export function assertInside(root, key) {
  const normalized = toPosix(key)
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.includes('\0')) {
    throw new Error(`非法的远端路径：${key}`)
  }
  const segments = normalized.split('/')
  if (segments.some((part) => part === '..')) throw new Error(`非法的远端路径：${key}`)
  return join(root, ...segments)
}

/**
 * Turn one exclusion pattern into a matcher.
 *
 * Supported syntax (the subset every backup product ships):
 *   `foo`            a path segment anywhere   → matches `a/foo/b`, not `a/foobar`
 *   `*.png`          a file name anywhere      → matches `a/b.png`
 *   `x/` + `**`      anything below a folder   → matches `a/x/b/c`
 *   `a/b`            an exact path prefix      → matches `a/b` and `a/b/c`
 * Patterns are matched against the posix relative key; a leading `/` is ignored.
 */
export function matchGlob(pattern, relativeKey) {
  const raw = String(pattern ?? '').trim().replace(/^\/+/, '')
  if (raw === '') return false
  const path = toPosix(relativeKey).replace(/^\/+/, '')

  if (raw.includes('/')) {
    const body = raw.replace(/\/+$/, '')
    const rx = new RegExp(
      `^${body
        .split('/')
        .map((segment) => {
          if (segment === '**') return '(?:.*)'
          return escapeRegex(segment).replace(/\\\*/g, '[^/]*').replace(/\\\?/g, '[^/]')
        })
        .join('/')}(?:/.*)?$`,
      'i',
    )
    return rx.test(path)
  }

  const segments = path.split('/')
  if (raw.includes('*') || raw.includes('?')) {
    const rx = new RegExp(`^${escapeRegex(raw).replace(/\\\*/g, '.*').replace(/\\\?/g, '.')}$`, 'i')
    return segments.some((segment) => rx.test(segment))
  }
  return segments.includes(raw)
}

function escapeRegex(value) {
  // `*` and `?` are escaped too: the callers re-introduce them as wildcards.
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function isExcluded(patterns, relativeKey) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false
  for (const pattern of patterns) {
    if (matchGlob(pattern, relativeKey)) return true
  }
  return false
}

/** `1 小时 12 分` / `48 秒`; used for durations in the panel. */
export function humanDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000)
  if (total < 60) return `${total.toFixed(total < 10 ? 1 : 0)} 秒`
  const minutes = Math.floor(total / 60)
  const seconds = Math.round(total % 60)
  if (minutes < 60) return seconds === 0 ? `${minutes} 分` : `${minutes} 分 ${seconds} 秒`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`
}

