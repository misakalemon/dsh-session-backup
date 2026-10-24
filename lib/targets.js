/**
 * Target = where the mirror lives. A target is a tiny adapter so the engine
 * never learns about WebDAV, S3, SFTP, … Each adapter provides:
 *
 *   kind                       stable id, matches `target` in the config
 *   label                      human readable, used in status output
 *   address                    redacted description of the destination
 *   put(key, absPath, size)    upload one file (size is a hint, may be 0)
 *   getText(key)               read a small text file, `undefined` when absent
 *   getTo(key, destAbs)        stream one key back to a local path
 *   putText(key, text)         write a small text file
 *   move(from, to)             rename one key (used to archive old versions)
 *   remove(key)                delete one key; missing keys are not an error
 *   probe()                    connectivity + write permission check
 *   dispose()                  optional cleanup
 *
 * Keys are posix-style relative paths (`sessions/<cwd>/<id>/session.jsonl.zstd`)
 * and never contain `..`. Implementations create missing parent collections
 * themselves.
 */

import { createDirTarget } from './target-dir.js'
import { createWebdavTarget } from './target-webdav.js'

export function createTarget(spec, log) {
  const kind = String(spec?.kind ?? '').trim().toLowerCase()
  if (kind === 'dir') return createDirTarget(spec, log)
  if (kind === 'webdav') return createWebdavTarget(spec, log)
  throw new Error(`未知的备份目标类型 "${kind}"，当前支持：webdav、dir`)
}
