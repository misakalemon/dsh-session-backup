/**
 * Host-half smoke test: no DSH kernel involved, just `apply()` with the
 * services it actually touches, then the management API through its real
 * handler. Verifies the settings layer (the reason the panel can change the
 * server address at all) and that the password never reaches config.json.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'dsbk-host-'))
process.env.DSH_HOME = home

const watchdog = setTimeout(() => {
  console.log('[watchdog] test is stuck, exiting')
  process.exit(3)
}, 15000)
watchdog.unref?.()

const credentials = new Map()
const registered = []

function makeCtx() {
  const webCtx = {
    effect(fn) {
      const dispose = fn()
      return dispose
    },
    webServer: {
      register(route) {
        registered.push(route)
        return () => {}
      },
    },
  }
  return {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'credentials') {
        return {
          async resolve(ref) {
            const value = credentials.get(ref)
            return value === undefined ? undefined : { value, source: 'record' }
          },
          async set(ref, value) {
            credentials.set(ref, value)
            return { ref }
          },
        }
      }
      if (name === 'sessions') return undefined
      if (name === 'sessionPersistence') return undefined
      if (name === 'timer') return undefined
      return undefined
    },
    on() {},
    effect(fn) {
      fn()
      return () => {}
    },
    inject(_names, callback) {
      callback(webCtx)
    },
  }
}

const { apply } = await import('../index.js')

console.log('[step] apply')
apply(makeCtx(), { target: 'webdav', schedule: { startupDelayMinutes: 0, intervalMinutes: 0 } })
console.log('[step] applied')
assert.equal(registered.length, 1, 'management API registered')
const route = registered[0]
assert.equal(route.kind, 'prefix')
assert.equal(route.path, '/session-backup/api')

async function call(method, body) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const chunks = payload === '' ? [] : [Buffer.from(payload, 'utf8')]
  const req = {
    method: 'POST',
    url: `/session-backup/api/${method}`,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  const res = {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status
    },
    end(text) {
      this.body = String(text ?? '')
    },
  }
  await route.handler(req, res)
  return { status: res.status, value: JSON.parse(res.body) }
}

// 1. Fresh install: nothing configured, and no config file was invented.
const before = await call('status')
assert.equal(before.value.ok, true)
assert.equal(before.value.value.configured, false)
assert.equal(before.value.value.settings.url, '')
assert.equal(before.value.value.hasPassword, false)

// 2. Saving the address must take effect without a restart.
const saved = await call('saveConfig', {
  target: 'webdav',
  url: 'https://dav.example.com/dav',
  prefix: 'dsh-session-backup/test-host',
  username: 'alice',
  password: 's3cret',
  timeoutSeconds: 45,
})
assert.equal(saved.value.ok, true)
assert.equal(saved.value.value.configured, true)
assert.equal(saved.value.value.settings.url, 'https://dav.example.com/dav')
assert.equal(saved.value.value.settings.prefix, 'dsh-session-backup/test-host')
assert.equal(saved.value.value.settings.timeoutSeconds, 45)
assert.equal(saved.value.value.passwordSaved, true)
assert.equal(saved.value.value.usernameSaved, true)
assert.equal(credentials.get('DSH_BACKUP_PASSWORD'), 's3cret')
assert.equal(credentials.get('DSH_BACKUP_USERNAME'), 'alice')

// 3. The settings file holds no secret.
const file = await readFile(join(home, 'session-backup', 'config.json'), 'utf8')
assert.equal(file.includes('s3cret'), false, 'password must not be written to config.json')
assert.equal(file.includes('alice'), false, 'username stays in the credentials store')
assert.equal(JSON.parse(file).remote.url, 'https://dav.example.com/dav')

// 4. status reflects it right away, and reports the secret presence.
const after = await call('status')
assert.equal(after.value.value.configured, true)
assert.equal(after.value.value.hasPassword, true)
assert.equal(after.value.value.settings.prefix, 'dsh-session-backup/test-host')

// 5. Switching to a directory target only needs the path.
const dir = await call('saveConfig', { target: 'dir', root: 'D:\\backup\\dsh' })
assert.equal(dir.value.value.configured, true)
assert.equal(dir.value.value.settings.target, 'dir')
assert.equal(dir.value.value.settings.root, 'D:\\backup\\dsh')
assert.equal(dir.value.value.settings.url, 'https://dav.example.com/dav', 'unrelated fields survive')

// 6. Running against an unconfigured plugin is refused with a readable message.
const cleared = await call('saveConfig', { target: 'dir', root: '' })
assert.equal(cleared.value.value.configured, false)
const run = await call('run')
assert.equal(run.value.ok, false)
assert.match(run.value.error.message, /还没有配置备份目标/)

// 7. Schedule mode, retention, exclusion rules and throttle round-trip.
const tuned = await call('saveConfig', {
  target: 'dir',
  root: 'D:\\backup\\dsh',
  schedule: { mode: 'daily', dailyAt: '03:30', onTurnEnd: false },
  exclude: '*.log\n**/scratch/**',
  versionsKeep: 3,
  deleteMode: 'mirror',
  retries: 1,
  bandwidthKBps: 512,
})
assert.equal(tuned.value.ok, true)
const settings = (await call('status')).value.value.settings
assert.equal(settings.schedule.mode, 'daily')
assert.equal(settings.schedule.dailyAt, '03:30')
assert.equal(settings.schedule.onTurnEnd, false)
assert.deepEqual(settings.exclude, ['*.log', '**/scratch/**'], 'textarea lines become patterns')
assert.equal(settings.versions.keep, 3)
assert.equal(settings.deleteMode, 'mirror')
assert.equal(settings.transfer.bandwidthKBps, 512)

// 8. Pause is sticky and visible to the panel.
const paused = await call('pause', { paused: true })
assert.equal(paused.value.value.paused, true)
assert.equal((await call('status')).value.value.paused, true)
await call('pause', { paused: false })
assert.equal((await call('status')).value.value.paused, false)

// 9. Verify needs a target as well.
await call('saveConfig', { target: 'dir', root: '' })
const verify = await call('verify')
assert.equal(verify.value.ok, false)
assert.match(verify.value.error.message, /还没有配置备份目标/)

console.log('host: all assertions passed')
clearTimeout(watchdog)
// apply() installs interval timers through the kernel in production; here they are
// plain timers, so the process has to end explicitly.
process.exit(0)
