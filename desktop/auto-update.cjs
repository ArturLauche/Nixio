// In-app update download/install on top of electron-updater.
//
// electron-updater checks `latest.yml` on the GitHub release, downloads the
// listed installer and verifies its sha512 before handing back a local path.
// Its own quitAndInstall() only drives NSIS/AppImage builds, while this repo
// ships an Inno Setup installer (see scripts/package-release.mjs), so the
// verified installer is launched with Inno's silent flags instead.
const { spawn } = require("node:child_process")

const FEED = { provider: "github", owner: "wiothemilo-lang", repo: "Nixio" }
// Inno Setup: install without the wizard, never reboot on our behalf.
const INSTALL_FLAGS = ["/SILENT", "/NORESTART", "/CLOSEAPPLICATIONS"]
const UNSUPPORTED = "Tự cập nhật trong ứng dụng chỉ khả dụng cho bản cài đặt Windows."

function loadUpdaterLib() {
  try {
    return require("electron-updater")
  } catch {
    return null
  }
}

function errorMessage(error) {
  return String(error?.message || error || "Cập nhật thất bại.").slice(0, 300)
}

function createAutoUpdater({
  lib = loadUpdaterLib(),
  app,
  platform = process.platform,
  spawnImpl = spawn,
  send = () => {},
  log = () => {},
  beforeQuit = () => {},
  quitDelayMs = 300,
} = {}) {
  const supported = Boolean(lib?.autoUpdater) && Boolean(app?.isPackaged) && platform === "win32"
  let state = {
    status: supported ? "idle" : "unsupported",
    supported,
    version: "",
    percent: 0,
    transferred: 0,
    total: 0,
    bytesPerSecond: 0,
    installer: "",
    error: "",
  }
  const publish = (patch) => {
    state = { ...state, ...patch }
    // Renderer payloads never need the local installer path.
    const { installer, ...visible } = state
    send(visible)
    return { ...state }
  }

  if (supported) {
    const updater = lib.autoUpdater
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.setFeedURL({ ...FEED })
    updater.logger = { info: log, warn: log, error: log, debug: () => {} }
    updater.on("download-progress", (progress) => {
      publish({
        status: "downloading",
        percent: Math.max(0, Math.min(100, Number(progress?.percent) || 0)),
        transferred: Number(progress?.transferred) || 0,
        total: Number(progress?.total) || 0,
        bytesPerSecond: Number(progress?.bytesPerSecond) || 0,
      })
    })
    updater.on("error", (error) => publish({ status: "error", error: errorMessage(error) }))
  }

  async function download() {
    if (!supported) throw new Error(UNSUPPORTED)
    if (state.status === "downloading") return { ...state }
    publish({ status: "checking", percent: 0, error: "", installer: "" })
    let result
    try {
      result = await lib.autoUpdater.checkForUpdates()
    } catch (error) {
      return publish({ status: "error", error: errorMessage(error) })
    }
    const version = String(result?.updateInfo?.version || "")
    if (!result?.updateInfo) {
      publish({ status: "none", version: version || state.version })
      return { ...state }
    }
    publish({ status: "downloading", version, percent: 0 })
    let files
    try {
      files = await lib.autoUpdater.downloadUpdate()
    } catch (error) {
      return publish({ status: "error", error: errorMessage(error) })
    }
    const installer = (Array.isArray(files) ? files : []).find((file) => typeof file === "string" && file)
    if (!installer) {
      return publish({ status: "error", error: "Không tìm thấy tệp cài đặt vừa tải." })
    }
    return publish({ status: "downloaded", percent: 100, installer })
  }

  function install() {
    if (!supported) throw new Error(UNSUPPORTED)
    if (state.status !== "downloaded" || !state.installer) {
      throw new Error("Chưa tải xong bản cập nhật để cài đặt.")
    }
    const child = spawnImpl(state.installer, INSTALL_FLAGS, { detached: true, stdio: "ignore" })
    child?.unref?.()
    publish({ status: "installing" })
    // The window close guard must not intercept the restart into the installer.
    beforeQuit()
    setTimeout(() => app.quit(), quitDelayMs)
    return { status: "installing" }
  }

  return {
    supported,
    snapshot: () => ({ ...state }),
    download,
    install,
    dispose() {
      lib?.autoUpdater?.removeAllListeners?.()
    },
  }
}

module.exports = {
  FEED,
  INSTALL_FLAGS,
  UNSUPPORTED,
  loadUpdaterLib,
  createAutoUpdater,
}
