/**
 * Local bookkeeping: what we last uploaded (keyed by the same remote key), and
 * a single-flight lock so a manual run and a scheduled run never interleave.
 *
 * The state file is small JSON. It is only an optimisation + history: the
 * remote `manifest.json` stays the source of truth for what the mirror holds,
 * so a lost state file degrades to a full hash pass, never to data loss.
 */

import { open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ensureDir } from './util.js'

export const STATE_VERSION = 1
const LOCK_STALE_MS = 2 * 60 * 60 * 1000

export function emptyState(host) {
  return { version: STATE_VERSION, host, updatedAt: new Date().toISOString(), files: {}, versions: {}, lastRun: null, history: [] }
}

export async function loadState(statePath, host) {
  try {
    const raw = await readFile(statePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return emptyState(host)
    return {
      version: STATE_VERSION,
      host: typeof parsed.host === 'string' && parsed.host !== '' ? parsed.host : host,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      files: parsed.files !== null && typeof parsed.files === 'object' ? parsed.files : {},
      versions: parsed.versions !== null && typeof parsed.versions === 'object' ? parsed.versions : {},
      lastRun: parsed.lastRun ?? null,
      history: Array.isArray(parsed.history) ? parsed.history : [],
      // Present only in zip mode; kept opaque here so the engine owns its shape.
      archive: parsed.archive !== null && typeof parsed.archive === 'object' ? parsed.archive : undefined,
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyState(host)
    // A corrupt state file must not brick the feature: start over.
    return emptyState(host)
  }
}

/** Atomic write: temp file in the same directory, then rename over. */
export async function saveState(statePath, state) {
  await ensureDir(dirname(statePath))
  const tmp = join(dirname(statePath), `.state.${process.pid}.${Date.now()}.tmp`)
  await writeFile(tmp, JSON.stringify(state), 'utf8')
  await rename(tmp, statePath)
}

async function lockIsStale(lockPath) {
  try {
    const info = await stat(lockPath)
    return Date.now() - info.mtimeMs > LOCK_STALE_MS
  } catch {
    return true
  }
}

/**
 * Take the run lock. Returns a release function, or `undefined` when another
 * run already holds it (the caller reports "busy" instead of queueing: a
 * backup is idempotent, so the next trigger picks the work up anyway).
 */
export async function acquireLock(lockPath) {
  await ensureDir(dirname(lockPath))
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx')
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), 'utf8')
      await handle.close()
      return async () => {
        try {
          await unlink(lockPath)
        } catch {
          /* already gone */
        }
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (await lockIsStale(lockPath)) {
        try {
          await unlink(lockPath)
        } catch {
          /* raced with someone else */
        }
        continue
      }
      return undefined
    }
  }
  return undefined
}
