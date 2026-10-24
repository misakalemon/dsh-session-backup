/**
 * The remote manifest is the mirror's own index: what key holds which content
 * hash. It lets a second machine (or a fresh install, with no local state file)
 * skip re-uploading identical bytes, and it makes restore self-describing.
 */

import { sha256Text } from './util.js'

export const MANIFEST_KEY = 'manifest.json'
export const MANIFEST_VERSION = 1

export function createManifest(host) {
  return { version: MANIFEST_VERSION, host, updatedAt: new Date().toISOString(), files: {} }
}

export function manifestDigest(manifest) {
  return sha256Text(
    JSON.stringify({
      version: manifest.version,
      host: manifest.host,
      files: Object.keys(manifest.files ?? {})
        .sort()
        .map((key) => [key, manifest.files[key]?.sha256 ?? '', manifest.files[key]?.size ?? 0]),
    }),
  )
}

/** Read the remote manifest; `undefined` when the mirror has none yet. */
export async function readManifest(target, key = MANIFEST_KEY) {
  let raw
  try {
    raw = await target.getText(key)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  if (raw === undefined || raw === null || String(raw).trim() === '') return undefined
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return undefined
    return {
      version: Number(parsed.version) || MANIFEST_VERSION,
      host: typeof parsed.host === 'string' ? parsed.host : '',
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
      files: parsed.files !== null && typeof parsed.files === 'object' ? parsed.files : {},
      // Zip mode keeps a single archive reference instead of per-file entries.
      archive: parsed.archive !== null && typeof parsed.archive === 'object' ? parsed.archive : undefined,
    }
  } catch {
    // A truncated/unparseable manifest is treated as absent: the runner then
    // falls back to hashing, which is slower but always correct.
    return undefined
  }
}

export async function writeManifest(target, manifest, key = MANIFEST_KEY) {
  manifest.updatedAt = new Date().toISOString()
  await target.putText(key, JSON.stringify(manifest, null, 2))
  return manifest
}
