// -----------------------------
// HARD-CODE YOUR TARGETS HERE
// -----------------------------
// Notes:
// - Browser cannot ICMP ping. This does HTTP reachability checks.
// - For servers, point to an HTTP endpoint (/, /health, /status, or any port with a web UI).
// - If a site doesn't allow CORS, we use mode:"no-cors" and treat a resolved fetch as "UP (opaque)".
//   (We can't read HTTP status in that case, but it still proves a network path exists.)

const REFRESH_EVERY_MS = 120_000;   // "every couple minutes"
const TIMEOUT_MS = 8_000;           // per target
const CONCURRENCY = 6;              // avoid spamming your network

const TARGETS = [
  // Websites
  { name: "jaydenhobbs.co.uk", kind: "WEBSITE", url: "https://jaydenhobbs.co.uk/" },
  { name: "hobbstech.co.uk", kind: "WEBSITE", url: "https://hobbstech.co.uk/" },
  { name: "devlindetailing.org", kind: "WEBSITE", url: "https://devlindetailing.org/" },

  // Servers / Services (examples — replace with your real endpoints)
  { name: "Proxmox Alpha", kind: "SERVER", url: "http://192.168.8.178:8006" },
  { name: "Proxmox Delta", kind: "SERVER", url: "http://192.168.8.224:8006" },
  { name: "Proxmox Bravo", kind: "SERVER", url: "http://192.168.8.50:8006" },

];

// -----------------------------
// UI + CHECK ENGINE
// -----------------------------
const listEl = document.getElementById("list");
const refreshBtn = document.getElementById("refreshBtn");
const intervalLabel = document.getElementById("intervalLabel");
const lastRunEl = document.getElementById("lastRun");
const summaryText = document.getElementById("summaryText");

intervalLabel.textContent = `${Math.round(REFRESH_EVERY_MS / 1000)}s`;

const state = new Map(); // url -> { status, latencyMs, lastChecked, note }

function fmtTime(d) {
  if (!d) return "—";
  return new Date(d).toLocaleString();
}
function fmtLatency(ms) {
  if (ms == null) return "—";
  return `${Math.round(ms)}ms`;
}

// Create initial list
function render() {
  const items = TARGETS.map(t => {
    const s = state.get(t.url) || { status: "CHECKING", latencyMs: null, lastChecked: null, note: "" };
    const cls = statusToClass(s.status);
    const label = statusToLabel(s.status, s.note);

    return `
      <li class="row ${cls}">
        <div class="left">
          <span class="badge">${escapeHtml(t.kind)}</span>
          <span class="name" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</span>
        </div>

        <div class="url" title="${escapeHtml(t.url)}">${escapeHtml(t.url)}</div>

        <div class="state">
          <span class="dot" aria-hidden="true"></span>
          <span class="stateText">${escapeHtml(label)}</span>
        </div>

        <div class="meta">
          <div>Last: <span class="muted">${escapeHtml(fmtTime(s.lastChecked))}</span></div>
          <div>RTT: <span class="muted">${escapeHtml(fmtLatency(s.latencyMs))}</span></div>
        </div>
      </li>
    `;
  }).join("");

  listEl.innerHTML = items;

  // Summary
  let up = 0, down = 0, checking = 0;
  for (const t of TARGETS) {
    const s = state.get(t.url);
    if (!s) { checking++; continue; }
    if (s.status === "UP" || s.status === "UP_OPAQUE") up++;
    else if (s.status === "DOWN") down++;
    else checking++;
  }
  summaryText.textContent = `${up} up • ${down} down • ${checking} checking`;
}

function statusToClass(status) {
  switch (status) {
    case "UP":
    case "UP_OPAQUE": return "state-ok";
    case "SLOW": return "state-warn";
    case "DOWN": return "state-bad";
    default: return "state-check";
  }
}

function statusToLabel(status, note) {
  if (status === "UP") return "UP & RUNNING";
  if (status === "UP_OPAQUE") return "UP & RUNNING";
  if (status === "SLOW") return "SLOW";
  if (status === "DOWN") return note ? `DOWN (${note})` : "DOWN";
  return "CHECKING";
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// A single HTTP reachability test
async function checkTarget(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const t0 = performance.now();

  // First try a normal fetch (lets us read status IF CORS allows)
  // If it fails due to CORS, we'll retry with no-cors.
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });

    const ms = performance.now() - t0;
    clearTimeout(timeout);

    // If we can read status, classify
    if (res.ok) return { status: ms > 1200 ? "SLOW" : "UP", latencyMs: ms, note: `HTTP ${res.status}` };
    return { status: "DOWN", latencyMs: ms, note: `HTTP ${res.status}` };
  } catch (err) {
    // Retry using no-cors. If it resolves, we can't read status, but it indicates reachability.
    // If it rejects/timeouts, treat as DOWN.
    try {
      const res2 = await fetch(url, {
        method: "GET",
        cache: "no-store",
        mode: "no-cors",
        signal: controller.signal,
      });

      const ms2 = performance.now() - t0;
      clearTimeout(timeout);

      // Opaque response => fetch resolved but not readable
      if (res2 && res2.type === "opaque") {
        return { status: ms2 > 1200 ? "SLOW" : "UP_OPAQUE", latencyMs: ms2, note: "CORS blocked details" };
      }
      return { status: ms2 > 1200 ? "SLOW" : "UP", latencyMs: ms2, note: "OK" };
    } catch (err2) {
      clearTimeout(timeout);
      const note = (err2 && err2.name === "AbortError") ? "timeout" : "unreachable";
      return { status: "DOWN", latencyMs: null, note };
    }
  }
}

// Concurrency-limited runner
async function runChecks() {
  const start = Date.now();
  lastRunEl.textContent = new Date(start).toLocaleTimeString();

  // Set all to checking immediately
  for (const t of TARGETS) {
    state.set(t.url, { status: "CHECKING", latencyMs: null, lastChecked: Date.now(), note: "" });
  }
  render();

  // Worker pool
  let i = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (i < TARGETS.length) {
      const idx = i++;
      const target = TARGETS[idx];

      const result = await checkTarget(target.url);
      state.set(target.url, {
        status: result.status,
        latencyMs: result.latencyMs,
        lastChecked: Date.now(),
        note: result.note || "",
      });

      render();
    }
  });

  await Promise.all(workers);

  // slight jitter so it doesn't always hit on the exact same second
  const end = Date.now();
  lastRunEl.textContent = `${new Date(end).toLocaleTimeString()}`;
}

// Button + timer
refreshBtn.addEventListener("click", () => runChecks());

render();
runChecks();

setInterval(() => {
  runChecks();
}, REFRESH_EVERY_MS + Math.floor(Math.random() * 1500));
