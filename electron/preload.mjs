import { contextBridge, ipcRenderer } from "electron";

// Renderer gets no Node access. Everything goes through this narrow API.
contextBridge.exposeInMainWorld("dm", {
  add: (url, opts) => ipcRenderer.invoke("dm:add", url, opts),
  pause: (id) => ipcRenderer.invoke("dm:pause", id),
  resume: (id) => ipcRenderer.invoke("dm:resume", id),
  cancel: (id) => ipcRenderer.invoke("dm:cancel", id),
  list: () => ipcRenderer.invoke("dm:list"),
  queues: () => ipcRenderer.invoke("dm:queues"),
  createQueue: (name) => ipcRenderer.invoke("dm:create-queue", name),
  renameQueue: (id, name) => ipcRenderer.invoke("dm:rename-queue", id, name),
  deleteQueue: (id) => ipcRenderer.invoke("dm:delete-queue", id),
  moveJob: (jobId, queueId) => ipcRenderer.invoke("dm:move-job", jobId, queueId),
  setQueueLimit: (queueId, bytesPerSec) => ipcRenderer.invoke("dm:set-queue-limit", queueId, bytesPerSec),
  addTorrent: (url, opts) => ipcRenderer.invoke("dm:add-torrent", url, opts),
  addStream: (url, opts) => ipcRenderer.invoke("dm:add-stream", url, opts),
  grab: (pageUrl) => ipcRenderer.invoke("dm:grab", pageUrl),
  chooseFile: () => ipcRenderer.invoke("dm:choose-file"),
  openDetails: (id) => ipcRenderer.invoke("dm:open-details", id),
  getInfo: () => ipcRenderer.invoke("dm:get-info"),
  getSettings: () => ipcRenderer.invoke("dm:get-settings"),
  setSettings: (partial) => ipcRenderer.invoke("dm:set-settings", partial),
  chooseFolder: () => ipcRenderer.invoke("dm:choose-folder"),
  openDownloadsFolder: () => ipcRenderer.invoke("dm:open-downloads-folder"),
  openFile: (id) => ipcRenderer.invoke("dm:open-file", id),
  openJobFolder: (id) => ipcRenderer.invoke("dm:open-job-folder", id),
  diskSpace: () => ipcRenderer.invoke("dm:disk-space"),
  // 0.7.0: mini widget, torrent stop-seeding, download statistics.
  toggleWidget: () => ipcRenderer.invoke("dm:toggle-widget"),
  stopSeeding: (id) => ipcRenderer.invoke("dm:stop-seeding", id),
  stats: () => ipcRenderer.invoke("dm:stats"),
  ytTools: () => ipcRenderer.invoke("dm:yt-tools"),
  ytInfo: (url) => ipcRenderer.invoke("dm:yt-info", url),
  ytAdd: (url, opts) => ipcRenderer.invoke("dm:yt-add", url, opts),
  ytInstallTool: (tool) => ipcRenderer.invoke("dm:yt-install-tool", tool),
  onProgress: (cb) => {
    const listener = (_event, progress) => cb(progress);
    ipcRenderer.on("dm:progress", listener);
    return () => ipcRenderer.removeListener("dm:progress", listener);
  },
  onJobs: (cb) => {
    const listener = (_event, jobs) => cb(jobs);
    ipcRenderer.on("dm:jobs", listener);
    return () => ipcRenderer.removeListener("dm:jobs", listener);
  },
  onClipboardUrl: (cb) => {
    const listener = (_event, url) => cb(url);
    ipcRenderer.on("dm:clipboard-url", listener);
    return () => ipcRenderer.removeListener("dm:clipboard-url", listener);
  },
});
