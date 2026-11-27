const { contextBridge, ipcRenderer } = require("electron")

async function invoke(channel, ...args) {
  const response = await ipcRenderer.invoke("khung-thoai:" + channel, ...args)
  if (response.error) throw new Error(response.error)
  return response.value
}
contextBridge.exposeInMainWorld("khungThoaiDesktop", {
  redrawTexture: (sample) => invoke("redraw-texture", sample),
  native: (operation, options, data, taskId) => invoke("native", operation, options, data, taskId),
  onTask: (callback) => ipcRenderer.on("khung-thoai:task", (_event, update) => callback(update)),
  cancelTask: (id) => invoke("task-cancel", id),
  onClose: (callback) => ipcRenderer.on("khung-thoai:closing", () => callback()),
  closeWindow: () => invoke("close"),
  projectList: () => invoke("project-list"),
  projectActivate: (id, candidate) => invoke("project-activate", id, candidate),
  projectStatus: () => invoke("project-status"),
  projectOpen: (mode) => invoke("project-open", mode),
  projectDiscardOpen: (id) => invoke("project-discard-open", id),
  projectRead: (id) => invoke("project-read", id),
  projectCancelRead: (id) => invoke("project-cancel-read", id),
  projectBegin: (mode, name, projectId) => invoke("project-begin", mode, name, projectId),
  projectWrite: (id, operation, options, data) => invoke("project-write", id, operation, options, data),
  webSearch: (query, options) => invoke("web-search", query, options),
  fetchUrl: (url, options) => invoke("fetch-url", url, options),
  appInfo: () => invoke("app-info"),
  checkUpdate: () => invoke("check-update"),
  openExternal: (url) => invoke("open-external", url),
  credentialStatus: (provider, endpoint) => invoke("credential-status", provider, endpoint),
  // Write-only: the key travels in and only a status and an opaque handle come back.
  credentialSave: (provider, endpoint, secret) => invoke("credential-save", provider, endpoint, secret),
  credentialRemove: (provider, endpoint) => invoke("credential-remove", provider, endpoint),
  // Selected-provider traffic runs in main. The renderer names a provider and an operation, never a
  // URL, a method or a header, and the key is attached in main.
  providerRequest: (request) => invoke("provider-request", request),
  providerStream: (request) => invoke("provider-stream", request),
  // Acknowledgement that the renderer is listening for this ticket's frames, plus a cancel that also
  // accepts the request token so work without a ticket yet (vault, DNS, headers) can be stopped.
  providerActivate: (ticket) => invoke("provider-activate", ticket),
  providerCancel: (target) => invoke("provider-cancel", target),
  // Returns a detached unsubscribe function, never the ipcRenderer object the listener was added to.
  onProviderEvent: (callback) => {
    if (typeof callback !== "function") return () => {}
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on("khung-thoai:provider-event", listener)
    return () => { ipcRenderer.removeListener("khung-thoai:provider-event", listener) }
  },
})
