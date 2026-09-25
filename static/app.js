const $ = (sel) => document.querySelector(sel);

const QUALITIES = {
  video: [
    ["best", "Best quality"],
    ["2160", "4K 2160p"],
    ["1440", "1440p"],
    ["1080", "1080p Full HD"],
    ["720", "720p HD"],
    ["480", "480p"],
    ["360", "360p"],
  ],
  audio: [
    ["mp3", "MP3"],
    ["m4a", "M4A"],
    ["opus", "OPUS"],
  ],
};

const STATUS_LABEL = {
  queued: "Queued",
  downloading: "Downloading",
  processing: "Converting",
  finished: "Completed",
  error: "Error",
  cancelled: "Cancelled",
};

const ACTIVE = ["queued", "downloading", "processing"];

let mode = "video";
const nodes = new Map();

// Live-update policy: the server pushes updates over SSE (/api/jobs is no
// longer polled in a tight loop). Polling is only a fallback for browsers
// without SSE, runs at a relaxed interval and stops as soon as no job is
// queued/downloading/processing.
const POLL_INTERVAL = 2500;
const MAX_FETCH_FAILURES = 3;
// Single persistent SSE connection policy: exactly one EventSource for the
// lifetime of the page. Reconnects use exponential backoff and there is only
// ever one pending reconnect timer, so we never hammer /api/events.
const RECONNECT_BASE = 1000;
const RECONNECT_MAX = 30000;
let currentJobs = [];
let pollTimer = null;
let sse = null;
let sseConnected = false;
let reconnectTimer = null;
let reconnectDelay = RECONNECT_BASE;
let visibilityTimer = null;
let offline = false;
let fetchFailures = 0;
let rateLimitedUntil = 0;
let rateLimitTimer = null;
let jobsRequest = null;

// Re-entrancy guards (button spam protection).
let previewBusy = false;
let downloadBusy = null;
let clearBusy = false;
const pendingJobActions = new Set();

const els = {
  urls: $("#urls"),
  quality: $("#quality"),
  playlist: $("#playlist"),
  fetch: $("#fetch"),
  download: $("#download"),
  clear: $("#clear"),
  jobs: $("#jobs"),
  empty: $("#empty"),
  preview: $("#preview"),
  formError: $("#form-error"),
  toast: $("#toast"),
  conn: $("#conn"),
  pill: $("#conn-pill"),
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function fmtSpeed(v) {
  if (!v) return "";
  if (v > 1048576) return (v / 1048576).toFixed(1) + " MB/s";
  return Math.round(v / 1024) + " KB/s";
}

function fmtEta(s) {
  if (s === null || s === undefined) return "";
  s = Math.max(0, Math.round(s));
  const m = Math.floor(s / 60);
  return "ETA " + m + ":" + String(s % 60).padStart(2, "0");
}

function fmtDur(s) {
  if (!s) return "";
  s = Math.round(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function fmtSize(b) {
  if (!b) return "";
  if (b > 1e9) return (b / 1e9).toFixed(2) + " GB";
  if (b > 1048576) return (b / 1048576).toFixed(1) + " MB";
  return Math.round(b / 1024) + " KB";
}

function toast(message, isError = false) {
  els.toast.textContent = message;
  els.toast.className = "toast glass show" + (isError ? " error" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { els.toast.className = "toast glass"; }, 3200);
}

function showFormError(message) {
  if (!message) {
    els.formError.classList.add("hidden");
    return;
  }
  els.formError.textContent = message;
  els.formError.classList.remove("hidden");
}

function setConn(state, message) {
  if (els.pill) els.pill.dataset.state = state;
  if (!message) {
    els.conn.classList.add("hidden");
    els.conn.textContent = "";
    els.conn.classList.remove("error");
    return;
  }
  els.conn.textContent = message;
  els.conn.classList.toggle("error", state === "offline");
  els.conn.classList.remove("hidden");
}

function renderQuality() {
  const list = QUALITIES[mode];
  const previous = els.quality.value;
  els.quality.innerHTML = list
    .map(([value, label]) => `<option value="${value}">${label}</option>`)
    .join("");
  if (list.some(([value]) => value === previous)) els.quality.value = previous;
}

function getUrls() {
  return els.urls.value
    .split(/[\n,]+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function isValidUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// Returns { urls } when everything checks out, otherwise { error }.
function validateLinks() {
  const all = getUrls();
  if (!all.length) return { error: "Paste at least one link first." };

  const invalid = all.filter((link) => !isValidUrl(link));
  if (invalid.length) {
    const extra = invalid.length > 1 ? ` (+${invalid.length - 1} more)` : "";
    return { error: `Not a valid link (needs http:// or https://): ${invalid[0]}${extra}` };
  }

  const seen = new Set();
  const urls = [];
  for (const link of all) {
    if (!seen.has(link)) {
      seen.add(link);
      urls.push(link);
    }
  }
  return { urls };
}

async function postJson(url, payload) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error("Can't reach the server. Check your connection and try again.");
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 429) {
      const retry = res.headers.get("Retry-After");
      throw new Error(`Too many requests${retry ? ` — retry in ${retry}s` : " — wait a few seconds and try again"}.`);
    }
    const detail = data.detail;
    throw new Error(
      typeof detail === "string" ? detail
        : Array.isArray(detail) ? detail.map((d) => d.msg || JSON.stringify(d)).join(", ")
        : detail ? JSON.stringify(detail)
        : `Request failed (${res.status})`
    );
  }
  return data;
}

function setBusy(button, busy, label) {
  if (busy && !button.dataset.label) button.dataset.label = button.textContent;
  button.disabled = busy;
  button.classList.toggle("busy", busy);
  if (busy) button.textContent = label || button.dataset.label;
  else if (button.dataset.label) button.textContent = button.dataset.label;
}

async function fetchInfo() {
  if (previewBusy) return;
  const checked = validateLinks();
  if (checked.error) {
    showFormError(checked.error);
    return;
  }
  showFormError("");

  previewBusy = true;
  setBusy(els.fetch, true, "Loading...");
  try {
    const results = await Promise.all(
      checked.urls.map((url) =>
        postJson("/api/info", { url })
          .then((data) => ({ ...data, url }))
          .catch((err) => ({ ok: false, error: err.message, url }))
      )
    );
    renderPreview(results);
  } finally {
    previewBusy = false;
    setBusy(els.fetch, false, "Preview");
  }
}

function renderPreview(items) {
  if (!items.length) {
    els.preview.classList.add("hidden");
    els.preview.innerHTML = "";
    return;
  }
  els.preview.classList.remove("hidden");
  els.preview.innerHTML = items.map((item) => {
    if (!item.ok) {
      return `
        <div class="preview-item">
          <div class="job-thumb">!</div>
          <div class="preview-body">
            <strong>${esc(item.url)}</strong>
            <span style="color:var(--err)">${esc(item.error || "Could not read this link")}</span>
          </div>
        </div>`;
    }
    const meta = [
      item.uploader,
      fmtDur(item.duration),
      item.type === "playlist" ? `${item.count} items` : "",
      item.heights && item.heights.length ? `up to ${item.heights[0]}p` : "",
    ].filter(Boolean).join(" · ");
    const thumb = item.thumbnail
      ? `<img src="${esc(item.thumbnail)}" alt="" loading="lazy" onerror="this.remove()">`
      : `<span>${item.type === "playlist" ? "&#128193;" : "&#127916;"}</span>`;
    return `
      <div class="preview-item">
        <div class="job-thumb">${thumb}</div>
        <div class="preview-body">
          <strong title="${esc(item.title)}">${esc(item.title)}</strong>
          <span>${esc(meta)}</span>
        </div>
      </div>`;
  }).join("");
}

async function startDownload() {
  if (downloadBusy) return;
  const checked = validateLinks();
  if (checked.error) {
    showFormError(checked.error);
    return;
  }
  showFormError("");

  // Skip links that are already queued or running, so spamming the button
  // (or re-submitting the same URL) never creates duplicate jobs.
  const activeUrls = new Set(
    currentJobs.filter((job) => ACTIVE.includes(job.status)).map((job) => job.url)
  );
  const fresh = checked.urls.filter((url) => !activeUrls.has(url));
  const skipped = checked.urls.length - fresh.length;
  if (!fresh.length) {
    toast("Those links are already in the queue.");
    return;
  }

  downloadBusy = true;
  setBusy(els.download, true, "Queueing...");
  try {
    const data = await postJson("/api/download", {
      urls: fresh,
      mode,
      quality: els.quality.value,
      playlist: els.playlist.checked,
    });
    const suffix = skipped ? ` (${skipped} already queued)` : "";
    toast(`Queued ${data.jobs.length} download${data.jobs.length > 1 ? "s" : ""}${suffix}`);
    await refreshJobs();
  } catch (err) {
    showFormError(err.message);
  } finally {
    downloadBusy = false;
    setBusy(els.download, false, "Download");
  }
}

function createJobEl(job) {
  const el = document.createElement("article");
  el.className = "job glass";
  el.dataset.id = job.id;
  el.innerHTML = `
    <div class="job-thumb"></div>
    <div class="job-main">
      <div class="job-top">
        <h3 class="job-title"></h3>
        <span class="badge"></span>
      </div>
      <div class="bar"><div class="fill"></div></div>
      <div class="job-meta"></div>
      <p class="job-error hidden"></p>
    </div>
    <div class="job-actions">
      <a class="btn primary save" href="#">Save</a>
      <button type="button" class="btn ghost cancel" data-action="cancel">Cancel</button>
      <button type="button" class="btn ghost danger remove" data-action="remove">Remove</button>
    </div>`;
  el._refs = {
    thumb: el.querySelector(".job-thumb"),
    title: el.querySelector(".job-title"),
    badge: el.querySelector(".badge"),
    fill: el.querySelector(".fill"),
    meta: el.querySelector(".job-meta"),
    error: el.querySelector(".job-error"),
    save: el.querySelector(".save"),
    cancel: el.querySelector(".cancel"),
    remove: el.querySelector(".remove"),
  };
  return el;
}

function updateJobEl(el, job) {
  const r = el._refs;
  el.dataset.status = job.status;

  const title = job.title || job.url;
  if (r.title.textContent !== title) r.title.textContent = title;
  r.title.title = title;

  const label = STATUS_LABEL[job.status] || job.status;
  if (r.badge.textContent !== label) r.badge.textContent = label;
  r.badge.dataset.for = job.status;

  const thumbSrc = job.thumbnail || "";
  const hasImg = Boolean(r.thumb.querySelector("img"));
  if (thumbSrc && !hasImg) {
    const img = document.createElement("img");
    img.src = thumbSrc;
    img.alt = "";
    img.loading = "lazy";
    img.onerror = () => img.remove();
    r.thumb.replaceChildren(img);
  } else if (!thumbSrc && hasImg) {
    r.thumb.replaceChildren();
  }
  if (!r.thumb.querySelector("img")) {
    const icon = job.mode === "audio" ? "\u266B" : "\u{1F3AC}";
    if (r.thumb.dataset.icon !== icon) {
      r.thumb.dataset.icon = icon;
      r.thumb.textContent = icon;
    }
  } else {
    r.thumb.dataset.icon = "";
  }

  let percent = job.percent || 0;
  if (job.status === "finished") percent = 100;
  percent = Math.max(0, Math.min(100, percent));
  const width = percent + "%";
  if (r.fill.style.width !== width) r.fill.style.width = width;

  const parts = [];
  if (job.status !== "queued") parts.push(`${Math.round(percent)}%`);
  if (job.status === "downloading") {
    const speed = fmtSpeed(job.speed);
    if (speed) parts.push(speed);
    const eta = fmtEta(job.eta);
    if (eta) parts.push(eta);
  }
  if (job.entries && job.entry) parts.push(`item ${job.entry}/${job.entries}`);
  if (job.status === "finished" && job.size) parts.push(fmtSize(job.size));
  const metaHtml = parts.map((p) => `<span>${esc(p)}</span>`).join("");
  if (r.meta.dataset.html !== metaHtml) {
    r.meta.dataset.html = metaHtml;
    r.meta.innerHTML = metaHtml;
  }

  if (job.error) {
    if (r.error.textContent !== job.error) r.error.textContent = job.error;
    r.error.classList.remove("hidden");
    r.error.title = job.error;
  } else {
    r.error.classList.add("hidden");
    r.error.removeAttribute("title");
  }

  const isActive = ACTIVE.includes(job.status);
  r.save.href = job.status === "finished" && job.file
    ? `/api/jobs/${job.id}/file`
    : "#";
  r.save.classList.toggle("hidden", !(job.status === "finished" && job.file));
  r.cancel.classList.toggle("hidden", !isActive);
  r.remove.classList.toggle("hidden", isActive);
}

function renderJobs(jobs) {
  const seen = new Set();
  for (const job of jobs) {
    seen.add(job.id);
    let el = nodes.get(job.id);
    if (!el) {
      el = createJobEl(job);
      nodes.set(job.id, el);
      els.jobs.appendChild(el);
    }
    updateJobEl(el, job);
  }
  for (const [id, el] of nodes) {
    if (!seen.has(id)) {
      el.remove();
      nodes.delete(id);
    }
  }
  els.empty.classList.toggle("hidden", jobs.length > 0);
}

function hasActiveJobs() {
  return currentJobs.some((job) => ACTIVE.includes(job.status));
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(refreshJobs, POLL_INTERVAL);
}

function syncLiveUpdates() {
  if (sseConnected || offline || rateLimitedUntil > Date.now()) {
    stopPolling();
    return;
  }
  if (hasActiveJobs()) startPolling();
  else stopPolling();
}

function applyJobs(jobs) {
  currentJobs = jobs;
  renderJobs(jobs);
  if (!offline && !rateLimitTimer) setConn(sseConnected ? "live" : "polling", "");
  syncLiveUpdates();
}

function handleRateLimit(res) {
  const retry = Math.max(1, Number(res.headers.get("Retry-After")) || 5);
  rateLimitedUntil = Date.now() + retry * 1000;
  stopPolling();
  setConn("polling", `Server is rate limiting requests — pausing updates for ${retry}s.`);
  clearTimeout(rateLimitTimer);
  rateLimitTimer = setTimeout(() => {
    rateLimitTimer = null;
    rateLimitedUntil = 0;
    setConn(sseConnected ? "live" : "polling", "");
    refreshJobs();
  }, retry * 1000);
}

async function refreshJobs() {
  if (offline || rateLimitedUntil > Date.now()) return;
  if (jobsRequest) jobsRequest.abort();
  const controller = new AbortController();
  jobsRequest = controller;
  try {
    const res = await fetch("/api/jobs", { cache: "no-store", signal: controller.signal });
    if (res.status === 429) {
      handleRateLimit(res);
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    fetchFailures = 0;
    applyJobs(data.jobs || []);
  } catch (err) {
    if (err.name === "AbortError") return;
    fetchFailures += 1;
    if (fetchFailures >= MAX_FETCH_FAILURES) {
      setConn("offline", "Can't reach the server — retrying automatically.");
    }
  } finally {
    if (jobsRequest === controller) jobsRequest = null;
  }
}

function sseAlive() {
  return Boolean(sse) && sse.readyState !== EventSource.CLOSED && sseConnected;
}

function scheduleReconnect() {
  if (reconnectTimer || offline) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectEvents();
  }, reconnectDelay);
  reconnectDelay = Math.min(RECONNECT_MAX, reconnectDelay * 2);
}

function connectEvents() {
  if (typeof EventSource === "undefined") {
    setConn("polling", "Live updates unavailable in this browser — polling while downloads run.");
    return;
  }
  // Idempotent: never open a second stream while one is connecting/open.
  if (sse && sse.readyState !== EventSource.CLOSED) return;
  if (sse) {
    try { sse.close(); } catch { /* ignore */ }
    sse = null;
  }

  sse = new EventSource("/api/events");
  sse.onopen = () => {
    sseConnected = true;
    fetchFailures = 0;
    reconnectDelay = RECONNECT_BASE;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    setConn("live", "");
    stopPolling();
  };
  sse.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      fetchFailures = 0;
      applyJobs(data.jobs || []);
    } catch {
      /* malformed frame, ignore */
    }
  };
  sse.onerror = () => {
    // Torn down on purpose (pagehide) — do not reconnect or poll.
    if (!sse || sse.readyState === EventSource.CLOSED) return;
    // Close the broken stream and reconnect once via backoff instead of
    // letting the browser retry aggressively while we also poll, which
    // previously created overlapping /api/events connections + /api/jobs
    // fetches on every error frame.
    try { sse.close(); } catch { /* ignore */ }
    sse = null;
    sseConnected = false;
    setConn("offline", "Live updates interrupted — reconnecting…");
    syncLiveUpdates();
    scheduleReconnect();
  };
}

function teardownLiveUpdates() {
  stopPolling();
  clearTimeout(toast._t);
  clearTimeout(rateLimitTimer);
  clearTimeout(reconnectTimer);
  clearTimeout(visibilityTimer);
  reconnectTimer = null;
  visibilityTimer = null;
  if (jobsRequest) {
    jobsRequest.abort();
    jobsRequest = null;
  }
  if (sse) {
    try { sse.close(); } catch { /* ignore */ }
    sse = null;
  }
  sseConnected = false;
}

// Guard against the script being evaluated twice (e.g. duplicate <script>
// tags or dev-tools re-injection): tear down the previous page instance so
// only one SSE connection and one set of listeners ever exists.
if (window.__mdCleanup) {
  try { window.__mdCleanup(); } catch { /* ignore */ }
}
window.__mdCleanup = teardownLiveUpdates;

window.addEventListener("pagehide", teardownLiveUpdates);

window.addEventListener("offline", () => {
  offline = true;
  stopPolling();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  setConn("offline", "You're offline — updates resume when the connection returns.");
});

window.addEventListener("online", () => {
  offline = false;
  reconnectDelay = RECONNECT_BASE;
  setConn(sseConnected ? "live" : "polling", "");
  connectEvents();
  refreshJobs();
});

document.addEventListener("visibilitychange", () => {
  // Debounce rapid hide/show flaps and never create a second stream.
  clearTimeout(visibilityTimer);
  if (document.visibilityState === "hidden") {
    stopPolling();
    return;
  }
  visibilityTimer = setTimeout(() => {
    // Tab became visible: if the single persistent stream is healthy, do
    // nothing — no refresh, no reconnect, no static-asset reload. Only
    // repair the connection when it is actually down.
    if (sseAlive()) {
      syncLiveUpdates();
      return;
    }
    connectEvents();
    refreshJobs();
  }, 300);
});

document.querySelectorAll("#mode button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#mode button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    mode = btn.dataset.mode;
    renderQuality();
  });
});

els.fetch.addEventListener("click", fetchInfo);
els.download.addEventListener("click", startDownload);
els.urls.addEventListener("input", () => showFormError(""));

els.clear.addEventListener("click", async () => {
  if (clearBusy) return;
  clearBusy = true;
  setBusy(els.clear, true);
  try {
    let res;
    try {
      res = await fetch("/api/jobs", { method: "DELETE" });
    } catch {
      toast("Can't reach the server.", true);
      return;
    }
    if (res.status === 429) {
      handleRateLimit(res);
      return;
    }
    if (!res.ok) {
      toast(`Clear failed (${res.status})`, true);
      return;
    }
    const data = await res.json();
    toast(`Cleared ${data.removed} entr${data.removed === 1 ? "y" : "ies"}`);
    await refreshJobs();
  } finally {
    clearBusy = false;
    setBusy(els.clear, false);
  }
});

els.jobs.addEventListener("click", async (event) => {
  // The "Save" anchor uses href="#" as a placeholder until the file is
  // ready. Swallow those clicks so background state updates can never
  // trigger a page navigation / full reload of `/` + static assets.
  const save = event.target.closest("a.save");
  if (save && (save.getAttribute("href") === "#" || save.classList.contains("hidden"))) {
    event.preventDefault();
    return;
  }
  const btn = event.target.closest("button[data-action]");
  if (!btn) return;
  const id = btn.closest(".job").dataset.id;
  if (pendingJobActions.has(id)) return;
  pendingJobActions.add(id);
  btn.disabled = true;
  try {
    const drop = btn.dataset.action === "remove";
    let res;
    try {
      res = await fetch(`/api/jobs/${id}?drop=${drop}`, { method: "DELETE" });
    } catch {
      toast("Can't reach the server.", true);
      return;
    }
    if (res.status === 429) {
      handleRateLimit(res);
      return;
    }
    if (!res.ok && res.status !== 404) {
      toast(`Request failed (${res.status})`, true);
      return;
    }
    await refreshJobs();
  } finally {
    pendingJobActions.delete(id);
    btn.disabled = false;
  }
});

offline = !navigator.onLine;
renderQuality();
connectEvents();
refreshJobs();
if (offline) setConn("offline", "You're offline — updates resume when the connection returns.");
