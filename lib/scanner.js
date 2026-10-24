/**
 * Enumerate the on-disk session data that gets mirrored.
 *
 * The backup unit is a *file*: the persistence layer exposes no byte surface
 * (no `readRaw`/path accessor on the abstract service), so reading the tree
 * directly is what keeps the copy byte-exact and independent of the storage
 * format version. Everything here is read-only.
 */

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

const DEFAULT_IGNORES = ['.tmp', '.lock', '.DS_Store', 'Thumbs.db']

/** One logical source tree, mirrored under `<prefix>/<name>/`. */
export const SOURCE_TREES = [
  { name: 'sessions', dir: 'sessions' },
  { name: 'attachments', dir: 'attachments' },
  { name: 'storages', dir: 'storages' },
]

function ignored(name) {
  if (DEFAULT_IGNORES.includes(name)) return true
  return name.endsWith('.tmp') || name.endsWith('.lock')
}

async function walk(root, relDir, out, options) {
  const absDir = relDir === '' ? root : join(root, relDir)
  let names
  try {
    names = await readdir(absDir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of names) {
    if (ignored(entry.name)) continue
    const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`
    if (entry.isDirectory()) {
      await walk(root, relPath, out, options)
      continue
    }
    if (!entry.isFile()) continue
    let info
    try {
      info = await stat(join(root, relPath))
    } catch {
      continue
    }
    if (!info.isFile()) continue
    if (options.maxFileBytes > 0 && info.size > options.maxFileBytes) {
      out.skipped.push({ key: relPath, size: info.size, reason: 'max-file-size' })
      continue
    }
    out.entries.push({ rel: relPath, abs: join(root, relPath), size: info.size, mtimeMs: Math.floor(info.mtimeMs) })
  }
}

/**
 * @returns {Promise<{entries: {rel: string, abs: string, size: number, mtimeMs: number}[], skipped: {key: string, size: number, reason: string}[], trees: {name: string, root: string, files: number, bytes: number}[]}>}
 */
export async function scanSources({ dshHome, scope, log }) {
  const maxFileBytes = Math.max(0, Number(scope.maxFileMB ?? 0)) * 1024 * 1024
  const maxAttachmentBytes = Math.max(0, Number(scope.maxAttachmentMB ?? 0)) * 1024 * 1024
  const entries = []
  const skipped = []
  const trees = []

  for (const tree of SOURCE_TREES) {
    if (scope[tree.name] === false) continue
    const root = join(dshHome, tree.dir)
    const local = { entries: [], skipped: [] }
    try {
      await walk(root, '', local, { maxFileBytes })
    } catch (error) {
      log('warn', `扫描 ${root} 失败：${error?.message ?? error}`)
      continue
    }
    let files = 0
    let bytes = 0
    for (const entry of local.entries) {
      // Per-file attachment cap: skipped files are reported, not failures.
      if (tree.name === 'attachments' && maxAttachmentBytes > 0 && entry.size > maxAttachmentBytes) {
        skipped.push({ key: `attachments/${entry.rel}`, size: entry.size, reason: 'max-attachment-size' })
        continue
      }
      entries.push({ ...entry, key: `${tree.name}/${entry.rel}`, tree: tree.name })
      files += 1
      bytes += entry.size
    }
    for (const item of local.skipped) skipped.push({ key: `${tree.name}/${item.key}`, size: item.size, reason: item.reason })
    trees.push({ name: tree.name, root, files, bytes })
  }

  return { entries, skipped, trees }
}
