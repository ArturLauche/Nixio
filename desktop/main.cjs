const { app, BrowserWindow, ipcMain, net, protocol, session } = require("electron")
const path = require("node:path")
const { pathToFileURL } = require("node:url")
const { TextureWorker } = require("./worker.cjs")

const origin = "app://khung-thoai"
const entry = origin + "/index.html"
const files = path.resolve(__dirname, "../dist")
const policy = [
  "default-src 'self'",
  "img-src 'self' https: blob: data:",
  "connect-src 'self' https:",
  "style-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ")

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
])

function workerExecutable() {
  const platform = { win32: "win", darwin: "osx", linux: "linux" }[process.platform]
  const rid = platform + "-" + process.arch
  const directory = app.isPackaged
    ? path.join(process.resourcesPath, "native-worker")
    : path.join(__dirname, "..", "native", "out", rid, "native-worker")
  return path.join(directory, "KhungThoai.Redraw" + (platform === "win" ? ".exe" : ""))
}

let worker
let mainWindow

function localFile(url) {
  const { hostname, pathname } = new URL(url)
  if (hostname !== "khung-thoai") return null
  const name = decodeURIComponent(pathname === "/" ? "/index.html" : pathname)
  const target = path.resolve(files, "." + name)
  const relative = path.relative(files, target)
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? target : null
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1420,
    height: 930,
    minWidth: 650,
    minHeight: 520,
    show: false,
    autoHideMenuBar: true,
    title: "Khung Thoại",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  })

  const { webContents } = mainWindow
  webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  webContents.on("will-navigate", (event) => event.preventDefault())
  webContents.on("will-attach-webview", (event) => event.preventDefault())
  mainWindow.once("ready-to-show", () => mainWindow.show())
  mainWindow.on("closed", () => { mainWindow = null })
  mainWindow.loadURL(entry)
}

app.whenReady().then(() => {
  worker = new TextureWorker(workerExecutable())
  ipcMain.handle("khung-thoai:redraw-texture", (event, input) => {
    const frame = event.senderFrame
    if (event.sender !== mainWindow?.webContents || frame?.parent || frame?.url.split("#", 1)[0] !== entry) return null
    if (!worker.available) return undefined
    return worker.redraw(input)
  })

  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  protocol.handle("app", async ({ url }) => {
    try {
      const target = localFile(url)
      if (!target) return new Response(null, { status: 404 })
      const response = await net.fetch(pathToFileURL(target).toString())
      const headers = new Headers(response.headers)
      headers.set("Content-Security-Policy", policy)
      return new Response(response.body, { status: response.status, headers })
    } catch {
      return new Response(null, { status: 404 })
    }
  })

  createWindow()
  app.on("activate", () => { if (!mainWindow) createWindow() })
})

app.on("before-quit", () => worker?.close())
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
