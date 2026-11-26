const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("khungThoaiDesktop", {
  redrawTexture: (sample) => ipcRenderer.invoke("khung-thoai:redraw-texture", sample),
})
