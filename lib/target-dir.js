/**
 * Directory target: a local folder, another drive, or a mounted UNC share.
 * Useful as a second hop (mail it via a sync client), and as the reference
 * implementation of the target contract.
 */

import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { assertInside, ensureDir } from './util.js'

export function createDirTarget(spec) {
  const root = String(spec.root ?? '').trim()
  if (root === '') throw new Error('dir 目标需要 root（目录路径）')

  const pathOf = (key) => assertInside(root, key)

  return {
    kind: 'dir',
    label: '本地 / 共享目录',
    address: root,

    async put(key, absPath) {
      const dest = pathOf(key)
      await mkdir(dirname(dest), { recursive: true })
      const tmp = `${dest}.part-${process.pid}`
      await copyFile(absPath, tmp)
      await rename(tmp, dest)
    },

    async getText(key) {
      try {
        return await readFile(pathOf(key), 'utf8')
      } catch (error) {
        if (error?.code === 'ENOENT') return undefined
        throw error
      }
    },

    async putText(key, text) {
      const dest = pathOf(key)
      await mkdir(dirname(dest), { recursive: true })
      const tmp = `${dest}.part-${process.pid}`
      await writeFile(tmp, text, 'utf8')
      await rename(tmp, dest)
    },

    /** Restore: copy one mirrored file back out to `destAbs`. */
    async getTo(key, destAbs) {
      await mkdir(dirname(destAbs), { recursive: true })
      const tmp = `${destAbs}.part-${process.pid}`
      await copyFile(pathOf(key), tmp)
      await rename(tmp, destAbs)
      return true
    },

    async remove(key) {
      try {
        await rm(pathOf(key), { force: true })
      } catch {
        /* deleting is best effort */
      }
    },

    /** Versioning: move the current copy aside before it is overwritten. */
    async move(from, to) {
      const source = pathOf(from)
      const destination = pathOf(to)
      await mkdir(dirname(destination), { recursive: true })
      await rename(source, destination)
      return true
    },

    async probe() {
      await ensureDir(root)
      const info = await stat(root)
      if (!info.isDirectory()) throw new Error(`${root} 不是目录`)
      const probeKey = `.probe-${process.pid}-${Date.now()}`
      await writeFile(join(root, probeKey), 'ok', 'utf8')
      await rm(join(root, probeKey), { force: true })
      return { ok: true, detail: `可写：${root}` }
    },
  }
}
