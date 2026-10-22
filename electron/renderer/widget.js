// Mini floating speed monitor (0.7.0). It listens to the same
// dm:progress broadcasts the main window gets — no extra polling.
// Speeds are summed per job id; a job with no recent event is dropped
// after 3 seconds so a finished download stops counting.
const speeds = new Map();
function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function render() {
  const now = Date.now();
  let total = 0;
  let active = 0;
  for (const [id, entry] of [...speeds.entries()]) {
    if (now - entry.at > 3000) {
      speeds.delete(id);
      continue;
    }
    if (entry.speed > 0) {
      total += entry.speed;
      active++;
    }
  }
  document.getElementById("widget-speed").textContent = `${formatBytes(Math.round(total))}/s`;
  document.getElementById("widget-sub").textContent =
    active > 0 ? `${active} downloading` : "No active downloads";
}
window.dm.onProgress((progress) => {
  speeds.set(progress.jobId, { speed: progress.speedBytesPerSec || 0, at: Date.now() });
  render();
});
window.dm.onJobs((jobs) => {
  const live = new Set(jobs.filter((job) => job.status === "downloading").map((job) => job.id));
  for (const id of [...speeds.keys()]) {
    if (!live.has(id)) speeds.delete(id);
  }
  render();
});
document.getElementById("widget-close").addEventListener("click", () => window.close());
setInterval(render, 1000);
