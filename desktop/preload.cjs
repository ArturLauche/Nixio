const { contextBridge, ipcRenderer } = require("electron")

async function invoke(channel, ...args) {
  const response = await ipcRenderer.invoke("khung-thoai:" + channel, ...args)
  if (response.error) throw new Error(response.error)
  return response.value
}
contextBridge.exposeInMainWorld("khungThoaiDesktop", {
  redrawTexture: (sample) => invoke("redraw-texture", sample),
  native: (operation, options, data) => invoke("native", operation, options, data),
  onClose: (callback) => ipcRenderer.on("khung-thoai:closing", () => callback()),
  closeWindow: () => invoke("close"),
  projectStatus: () => invoke("project-status"),
  projectOpen: (mode) => invoke("project-open", mode),
  projectRead: (id) => invoke("project-read", id),
  projectCancelRead: (id) => invoke("project-cancel-read", id),
  projectBegin: (mode, name) => invoke("project-begin", mode, name),
  projectWrite: (id, operation, options, data) => invoke("project-write", id, operation, options, data),
})
