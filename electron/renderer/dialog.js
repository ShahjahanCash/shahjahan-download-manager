const jobId = new URLSearchParams(window.location.search).get("jobId");

function formatBytes(n) {
  if (n == null || !Number.isFinite(n)) return "?";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${(n / 1024 ** 3).toFixed(2)} GiB`;
}
function formatEta(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return "--:--";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Match the main window theme + accent (localStorage is per-origin,
// and both windows share the app origin, so this just works). Falls
// back to the old single dm-theme toggle for pre-0.6.2 windows.
(function applyDialogTheme() {
  let theme = "system";
  let accent = "green";
  try {
    const saved = JSON.parse(localStorage.getItem("sdm-settings") || "null");
    if (saved) {
      if (saved.theme) theme = saved.theme;
      if (saved.accent) accent = saved.accent;
    } else if (localStorage.getItem("dm-theme")) {
      theme = localStorage.getItem("dm-theme");
    }
  } catch { /* defaults */ }
  const resolved = theme === "system"
    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : theme;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.accent = accent;
})();

function render(job) {
  if (!job) return;
  const p = job.progress;
  const pct = p && p.percent != null ? p.percent * 100 : 0;
  const mainBar = document.getElementById("main-bar");
  mainBar.className = `bar ${job.status}`;
  mainBar.firstElementChild.style.width = `${Math.min(100, pct)}%`;
  document.getElementById("filename").textContent = job.filename;
  document.getElementById("url").textContent = job.url;
  document.getElementById("destination").textContent = job.destination;
  const statusEl = document.getElementById("status");
  statusEl.textContent = job.status;
  statusEl.className = `pill ${job.status}`;
  // Real actions, same bridge as the main window (the dialog uses
  // the shared preload): pause a running job, resume a paused one,
  // retry a failed one. Completed jobs get no action — there is
  // nothing to pause or retry.
  document.getElementById("dlg-pause").classList.toggle("hidden",
    !(job.status === "downloading" || job.status === "queued"));
  document.getElementById("dlg-resume").classList.toggle("hidden", job.status !== "paused");
  document.getElementById("dlg-retry").classList.toggle("hidden", job.status !== "failed");
  document.getElementById("progress").textContent = p
    ? `${p.percent != null ? (p.percent * 100).toFixed(1) : "?"}% · ${formatBytes(p.downloadedBytes)} / ${p.totalBytes != null ? formatBytes(p.totalBytes) : "?"}`
    : "—";
  document.getElementById("speed").textContent = p ? `${formatBytes(Math.round(p.speedBytesPerSec))}/s` : "—";
  document.getElementById("eta").textContent = p ? formatEta(p.etaSeconds) : "--:--";
  document.getElementById("error").textContent = job.error ?? "";
  // 0.7.2 transparency: the exact yt-dlp command for YouTube jobs, and
  // an honest engine summary for everything else. Restored YouTube
  // jobs have no recorded command (it is runtime-only), so they show —.
  let command = "—";
  let engine = "—";
  if (job.isYoutube) {
    engine = "YouTube · yt-dlp";
    command = job.ytCommand || "—";
  } else if (job.isTorrent) {
    engine = "Torrent · WebTorrent";
    command = job.url || "—";
  } else if (job.isStream || job.isLiveStream) {
    engine = "Stream · HLS/DASH segments, ffmpeg remux";
    command = job.url || "—";
  } else if (job.isFtp) {
    engine = "FTP · single stream with resume";
    command = job.url || "—";
  } else {
    const segs = job.segments ?? job.progress?.segments.length ?? 1;
    const limit = job.speedLimitBytesPerSec ? `${formatBytes(job.speedLimitBytesPerSec)}/s` : "unlimited";
    engine = `HTTP Range · ${segs} parallel segments · job limit ${limit}`;
    command = job.url || "—";
  }
  document.getElementById("engine").textContent = engine;
  document.getElementById("command").textContent = command;
  currentCommand = command === "—" ? "" : command;
  document.getElementById("copy-command").style.display = currentCommand ? "" : "none";
  const chunksEl = document.getElementById("chunks");
  if (!p || !p.segments.length) {
    chunksEl.innerHTML = "<p>Waiting for segments…</p>";
    return;
  }
  // Streams report one segment per media segment (hundreds for a long
  // video): cap the detail rows instead of rendering them all.
  const shown = p.segments.slice(0, 100);
  chunksEl.innerHTML = shown.map((segment, i) => {
    const length = segment.end - segment.start + 1;
    const pct = Math.min(100, Math.round((segment.downloaded / length) * 100));
    return `<div class="chunk-row"><div class="row"><span>Chunk ${i + 1}</span><span class="mono">${pct}% · ${formatBytes(segment.downloaded)} / ${formatBytes(length)}</span></div>
      <div class="chunk-bar"><div class="chunk" style="flex:1"><div style="width:${pct}%"></div></div></div></div>`;
  }).join("") + (p.segments.length > 100 ? `<p>+${p.segments.length - 100} more segments…</p>` : "");
}

let currentCommand = "";
document.getElementById("dlg-pause").addEventListener("click", async () => {
  await window.dm.pause(jobId);
});
document.getElementById("dlg-resume").addEventListener("click", async () => {
  await window.dm.resume(jobId);
});
document.getElementById("dlg-retry").addEventListener("click", async () => {
  await window.dm.resume(jobId);
});
document.getElementById("copy-command").addEventListener("click", async () => {
  if (!currentCommand) return;
  try {
    await navigator.clipboard.writeText(currentCommand);
  } catch { /* clipboard unavailable: the text is still visible to copy */ }
});

window.dm.onJobs((jobs) => {
  const job = jobs.find((candidate) => candidate.id === jobId);
  if (job) render(job);
});
window.dm.list().then((jobs) => {
  const job = jobs.find((candidate) => candidate.id === jobId);
  if (job) render(job);
});
