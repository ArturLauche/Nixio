import test from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { EventEmitter } from "node:events"
import { buildLatestYaml } from "../scripts/package-release.mjs"

const require = createRequire(import.meta.url)
const { createAutoUpdater, INSTALL_FLAGS, FEED, UNSUPPORTED } = require("../desktop/auto-update.cjs")

function fakeUpdater(overrides = {}) {
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    feedUrl: null,
    setFeedURL(feed) { this.feedUrl = feed },
    async checkForUpdates() {
      return { updateInfo: { version: "1.4.0" } }
    },
    async downloadUpdate() {
      return ["C:\\Users\\me\\AppData\\Local\\khung-thoai-updater\\pending\\Khung-Thoai-1.4.0-win-x64-setup.exe"]
    },
    ...overrides,
  })
}

function setup(overrides = {}) {
  const updater = overrides.updater ?? fakeUpdater()
  const spawned = []
  const events = []
  const quit = { count: 0, beforeQuit: 0 }
  const auto = createAutoUpdater({
    lib: { autoUpdater: updater },
    app: { isPackaged: true, quit: () => { quit.count += 1 } },
    beforeQuit: () => { quit.beforeQuit += 1 },
    platform: "win32",
    quitDelayMs: 0,
    spawnImpl: (file, args, options) => {
      spawned.push({ file, args, options })
      return { unref() {} }
    },
    send: (state) => events.push(state),
    ...overrides.options,
  })
  return { auto, updater, spawned, events, quit }
}

test("auto updater only activates for packaged Windows builds", () => {
  const updater = fakeUpdater()
  const noLib = createAutoUpdater({ lib: null, app: { isPackaged: true, quit() {} }, platform: "win32" })
  assert.equal(noLib.supported, false)
  assert.equal(noLib.snapshot().status, "unsupported")
  assert.throws(() => noLib.install(), new RegExp(UNSUPPORTED))

  const dev = createAutoUpdater({ lib: { autoUpdater: updater }, app: { isPackaged: false, quit() {} }, platform: "win32" })
  assert.equal(dev.supported, false)

  const linux = createAutoUpdater({ lib: { autoUpdater: updater }, app: { isPackaged: true, quit() {} }, platform: "linux" })
  assert.equal(linux.supported, false)

  const win = createAutoUpdater({ lib: { autoUpdater: updater }, app: { isPackaged: true, quit() {} }, platform: "win32" })
  assert.equal(win.supported, true)
})

test("download wires the GitHub feed and never auto-downloads or auto-installs", () => {
  const { updater } = setup()
  assert.deepEqual(updater.feedUrl, FEED)
  assert.equal(updater.autoDownload, false)
  assert.equal(updater.autoInstallOnAppQuit, false)
})

test("download reports progress and exposes the verified installer only after finishing", async () => {
  const { auto, updater, events } = setup()
  const pending = auto.download()
  updater.emit("download-progress", { percent: 42.4, transferred: 420, total: 1000, bytesPerSecond: 2048 })
  const state = await pending

  assert.equal(state.status, "downloaded")
  assert.equal(state.version, "1.4.0")
  assert.equal(state.percent, 100)
  assert.match(state.installer, /setup\.exe$/)
  const progress = events.find((event) => event.status === "downloading" && event.percent === 42.4)
  assert.ok(progress)
  // Renderer payloads never carry local filesystem paths.
  assert.equal(events.every((event) => event.installer === undefined), true)
})

test("download surfaces check and download failures as an error state", async () => {
  const failingCheck = setup({ updater: fakeUpdater({ async checkForUpdates() { throw new Error("offline") } }) })
  assert.equal((await failingCheck.auto.download()).status, "error")
  assert.equal(failingCheck.auto.snapshot().error, "offline")

  const failingDownload = setup({ updater: fakeUpdater({ async downloadUpdate() { throw new Error("sha512 mismatch") } }) })
  const state = await failingDownload.auto.download()
  assert.equal(state.status, "error")
  assert.equal(state.error, "sha512 mismatch")
})

test("download reports none when the feed has no newer release", async () => {
  const { auto } = setup({ updater: fakeUpdater({ async checkForUpdates() { return null } }) })
  assert.equal((await auto.download()).status, "none")
})

test("install refuses before a download finished and then launches the installer silently", async () => {
  const { auto, spawned, quit } = setup()
  assert.throws(() => auto.install(), /Chưa tải xong/)

  await auto.download()
  auto.install()
  await new Promise((resolve) => setTimeout(resolve, 5))

  assert.equal(spawned.length, 1)
  assert.match(spawned[0].file, /setup\.exe$/)
  assert.deepEqual(spawned[0].args, INSTALL_FLAGS)
  assert.equal(spawned[0].options.detached, true)
  assert.equal(quit.count, 1)
  assert.equal(quit.beforeQuit, 1)
  assert.equal(auto.snapshot().status, "installing")
})

test("buildLatestYaml matches the electron-updater feed format", () => {
  const yaml = buildLatestYaml({
    version: "v1.4.0",
    file: "Khung-Thoai-1.4.0-win-x64-setup.exe",
    size: 123456,
    sha512: "AbC+/dEf==",
    releaseDate: "2026-11-27T00:00:00.000Z",
  })
  assert.match(yaml, /^version: 1\.4\.0$/m)
  assert.match(yaml, /url: Khung-Thoai-1\.4\.0-win-x64-setup\.exe/)
  assert.match(yaml, /sha512: AbC\+\/dEf==/)
  assert.match(yaml, /size: 123456/)
  assert.match(yaml, /path: Khung-Thoai-1\.4\.0-win-x64-setup\.exe/)
  assert.match(yaml, /releaseDate: '2026-11-27T00:00:00\.000Z'/)
})
