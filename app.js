// Murph Test 2026 — Live segment tracker dashboard
//
// Rehearsal fork of ironhike-tracker. Same pipeline applied to a Murph workout
// on Saturday May 16, 2026. 22 segments: mile-1 + 20 Cindy rounds + mile-2.
// Push backend is shared with IronHike (same Cloudflare Worker, same secret).
const PROD_LAPS_CSV_URL   = "https://docs.google.com/spreadsheets/d/e/2PACX-1vSSqCYGBu6Ro0ubVu0MfT7LoyThQhQT0yFnO6HmAk-Npa9A8K0OqoEYoxR_Ya1Qx6AEGb7GNvKHbKCx/pub?gid=1616123796&single=true&output=csv";
const PROD_CONFIG_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vSSqCYGBu6Ro0ubVu0MfT7LoyThQhQT0yFnO6HmAk-Npa9A8K0OqoEYoxR_Ya1Qx6AEGb7GNvKHbKCx/pub?gid=516113094&single=true&output=csv";

const REFRESH_MS    = 60_000;
const REST_MIN      = 10; // minutes between segments before status flips to "Resting" (Murph is short)
const DUP_SEC       = 20; // consecutive timestamps closer than this look like accidental double-taps (Cindy rounds can be fast)

// Web Push backend (self-hosted Cloudflare Worker).
const PUSH_WORKER_URL  = "https://ironhike-push.beyond-the-hudson-918.workers.dev";
const VAPID_PUBLIC_KEY = "BF9wwg-Dj93wNjIPdXisxSNg5wJpzHVD62Jag-HttBRiS1RZ1VmQgMvo0kTLHeFSrV9F7ca2xT0-PTQ42YxVqR0";

// ---------- sim / time-travel ----------
const params = new URLSearchParams(location.search);
const SIM_NAME = params.get("sim");
let SIM_NOW = null;
if (params.get("simNow")) {
  const d = new Date(params.get("simNow"));
  if (!isNaN(d)) SIM_NOW = d;
}
let LAPS_CSV_URL   = PROD_LAPS_CSV_URL;
let CONFIG_CSV_URL = PROD_CONFIG_CSV_URL;
if (SIM_NAME) {
  LAPS_CSV_URL   = `./sim/${SIM_NAME}-laps.csv`;
  CONFIG_CSV_URL = `./sim/${SIM_NAME}-config.csv`;
}
function getNow() { return SIM_NOW ? new Date(SIM_NOW.getTime()) : new Date(); }

// Fallback config — overridden by values in the `config` sheet tab once it loads.
const FALLBACK_CONFIG = {
  start_iso:            "2026-05-16T08:00:00-04:00",
  cutoff_iso:           "2026-05-16T09:30:00-04:00",
  total_laps:           22,
  elevation_ft_per_lap: 0,
  athlete_name:         "Matt Ricci",
};

// ---------- CSV ----------

async function fetchCsv(url) {
  const r = await fetch(url + (url.includes("?") ? "&" : "?") + "cachebust=" + Date.now());
  if (!r.ok) throw new Error("fetch " + url + " → " + r.status);
  return parseCsv(await r.text());
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i+1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQ = false;
      else cell += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
      else if (c === "\r") { /* skip */ }
      else cell += c;
    }
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function configFromCsv(rows) {
  const cfg = { ...FALLBACK_CONFIG };
  for (const r of rows) {
    if (!r || r.length < 2) continue;
    const k = (r[0] || "").trim();
    const v = (r[1] || "").trim();
    if (!k || k.toLowerCase() === "key") continue;
    if (k === "total_laps" || k === "elevation_ft_per_lap") cfg[k] = Number(v);
    else cfg[k] = v;
  }
  return cfg;
}

function lapsFromCsv(rows) {
  const out = [];
  for (const r of rows) {
    if (!r || !r[0]) continue;
    const ts = r[0].trim();
    if (!ts || ts.toLowerCase().startsWith("timestamp")) continue;
    const d = new Date(ts);
    if (!isNaN(d)) out.push({ t: d, note: (r[1] || "").trim() });
  }
  return out.sort((a, b) => a.t - b.t);
}

// ---------- formatting ----------

const pad = n => (n < 10 ? "0" + n : "" + n);

function fmtDur(ms) {
  if (ms == null || isNaN(ms)) return "—";
  const sign = ms < 0 ? "-" : "";
  ms = Math.abs(ms);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h >= 1) return `${sign}${h}h ${pad(m)}m`;
  const s = Math.floor((ms % 60_000) / 1000);
  return `${sign}${m}m ${pad(s)}s`;
}

function fmtPerLap(ms) {
  if (ms == null || isNaN(ms) || !isFinite(ms) || ms <= 0) return "—";
  return "1 / " + fmtDur(ms);
}

const fmtInt = n => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

// ---------- render ----------

let chart = null;

function render(cfg, laps) {
  const now = getNow();
  const start = new Date(cfg.start_iso);
  const cutoff = new Date(cfg.cutoff_iso);
  const total = cfg.total_laps;
  const ft = cfg.elevation_ft_per_lap;

  const done = laps.length;
  const remainingLaps = Math.max(0, total - done);
  const elapsedMs = now - start;
  const cutoffMs  = cutoff - now;

  document.getElementById("title").textContent = `Murph Test — ${cfg.athlete_name}`;
  document.getElementById("laps-done").textContent  = done;
  document.getElementById("laps-total").textContent = total;
  // Elevation row repurposed: hide entirely when ft=0 (Murph has no elevation component).
  const elevEl = document.getElementById("elevation");
  if (ft > 0) {
    elevEl.textContent = `${fmtInt(done * ft)} ft / ${fmtInt(total * ft)} ft`;
    elevEl.hidden = false;
  } else {
    elevEl.hidden = true;
  }
  const pct = total ? (done / total) * 100 : 0;
  document.getElementById("percent").textContent = pct.toFixed(1) + "%";
  document.getElementById("progress-bar").style.width = Math.min(100, pct) + "%";

  document.getElementById("elapsed").textContent   = elapsedMs > 0 ? fmtDur(elapsedMs) : "not started";
  document.getElementById("remaining").textContent = cutoffMs > 0 ? fmtDur(cutoffMs) : "CUTOFF PASSED";

  // Budget per lap (used for both the BUFFER projection and NEXT LAP DUE BY deadline).
  const budgetMs = remainingLaps > 0 && cutoffMs > 0 ? cutoffMs / remainingLaps : null;
  const actualMs = done > 0 && elapsedMs > 0 ? elapsedMs / done : null;

  // BUFFER: projected finish vs cutoff, using cumulative pace.
  const bufferBox = document.getElementById("buffer-box");
  const bufferEl  = document.getElementById("buffer");
  const bufferNote = document.getElementById("buffer-note");
  bufferBox.classList.remove("good", "bad");
  if (done === 0 || actualMs == null) {
    bufferEl.textContent = "—";
    bufferNote.textContent = "starts updating after lap 1";
  } else if (remainingLaps === 0) {
    bufferEl.textContent = "FINISHED";
    bufferBox.classList.add("good");
    bufferNote.textContent = "at " + laps[laps.length-1].t.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } else if (cutoffMs <= 0) {
    bufferEl.textContent = "CUTOFF PASSED";
    bufferBox.classList.add("bad");
    bufferNote.textContent = `${done}/${total} laps completed`;
  } else {
    const projectedFinish = new Date(now.getTime() + remainingLaps * actualMs);
    const buf = cutoff - projectedFinish;
    bufferEl.textContent = (buf >= 0 ? "+" : "−") + fmtDur(Math.abs(buf)) + (buf >= 0 ? " ahead" : " behind");
    bufferBox.classList.add(buf >= 0 ? "good" : "bad");
    bufferNote.textContent = "projected finish " + projectedFinish.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  // NEXT LAP DUE BY: wall-clock deadline for the next lap based on budget.
  const dueEl  = document.getElementById("due-by");
  const dueNote = document.getElementById("due-note");
  if (remainingLaps === 0) {
    dueEl.textContent = "—";
    dueNote.textContent = "all laps complete";
  } else if (cutoffMs <= 0) {
    dueEl.textContent = "—";
    dueNote.textContent = "cutoff passed";
  } else if (elapsedMs <= 0) {
    dueEl.textContent = start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    dueNote.textContent = "event start";
  } else {
    const dueAt = new Date(now.getTime() + budgetMs);
    dueEl.textContent = dueAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    dueNote.textContent = `${fmtDur(budgetMs)} from now — your running budget`;
  }

  // Last summit + status
  if (done > 0) {
    const last = laps[laps.length - 1].t;
    const since = now - last;
    document.getElementById("last-summit").textContent = fmtDur(since) + " ago";
    const isResting = since > REST_MIN * 60_000;
    document.getElementById("status").textContent = isResting ? `Resting — ${fmtDur(since)}` : "Active";
  } else {
    document.getElementById("last-summit").textContent = "—";
    document.getElementById("status").textContent = elapsedMs < 0 ? "pre-event" : "waiting for lap 1";
  }

  renderDupes(laps);
  renderChart(start, cutoff, total, laps, now);

  document.getElementById("updated").textContent =
    "updated " + now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function renderDupes(laps) {
  const wrap = document.getElementById("dupes");
  if (!wrap) return;
  const pairs = [];
  for (let i = 1; i < laps.length; i++) {
    const gap = (laps[i].t - laps[i-1].t) / 1000;
    if (gap < DUP_SEC) pairs.push({ a: i, b: i + 1, gap });
  }
  if (pairs.length === 0) { wrap.hidden = true; wrap.innerHTML = ""; return; }
  wrap.hidden = false;
  wrap.innerHTML = `
    <div class="k">POSSIBLE DUPLICATE${pairs.length > 1 ? "S" : ""}</div>
    <div class="v">${pairs.map(p => `row ${p.a} &amp; ${p.b} <span class="thin">(${p.gap.toFixed(0)}s apart)</span>`).join("<br>")}</div>
    <div class="note">If accidental, delete the extra row in the Sheets iOS app.</div>
  `;
}

function renderChart(start, cutoff, total, laps, now) {
  const ctx = document.getElementById("chart");

  // Step series: at each lap timestamp, cumulative count jumps to N.
  const stepPts = [{ x: start, y: 0 }];
  laps.forEach((lap, i) => {
    stepPts.push({ x: lap.t, y: i });       // hold previous value to this point
    stepPts.push({ x: lap.t, y: i + 1 });   // then jump
  });
  // Extend horizontal line to "now" so the curve shows current standing.
  if (laps.length > 0 && now > laps[laps.length - 1].t) {
    stepPts.push({ x: now, y: laps.length });
  } else if (laps.length === 0 && now > start) {
    stepPts.push({ x: now, y: 0 });
  }

  const required = [{ x: start, y: 0 }, { x: cutoff, y: total }];

  const datasets = [
    {
      label: "Required pace",
      data: required,
      borderColor: "rgba(152, 162, 175, 0.7)",
      borderDash: [6, 6],
      borderWidth: 2,
      pointRadius: 0,
      fill: false,
      tension: 0,
    },
    {
      label: "Your progress",
      data: stepPts,
      borderColor: "#ffb648",
      backgroundColor: "rgba(255, 182, 72, 0.15)",
      borderWidth: 2.5,
      pointRadius: 0,
      fill: true,
      tension: 0,
    },
  ];

  if (chart) {
    chart.data.datasets = datasets;
    chart.options.scales.x.min = start;
    chart.options.scales.x.max = cutoff;
    chart.options.scales.y.max = total;
    chart.update("none");
    return;
  }

  chart = new Chart(ctx, {
    type: "line",
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: true, labels: { color: "#98a2af", boxWidth: 12, font: { size: 11 } } },
        tooltip: { enabled: false },
      },
      scales: {
        x: {
          type: "time",
          min: start,
          max: cutoff,
          time: { unit: "hour", displayFormats: { hour: "EEE ha" } },
          ticks: { color: "#98a2af", font: { size: 10 }, maxRotation: 0, autoSkipPadding: 16 },
          grid: { color: "#262c34" },
        },
        y: {
          min: 0,
          max: total,
          ticks: { color: "#98a2af", font: { size: 10 }, stepSize: 10 },
          grid: { color: "#262c34" },
        },
      },
    },
  });
}

// ---------- sim banner ----------

function installSimBanner() {
  if (!SIM_NAME && !SIM_NOW) return;
  const b = document.createElement("div");
  b.id = "sim-banner";
  const parts = [];
  if (SIM_NAME) parts.push(`SIM: ${SIM_NAME}`);
  if (SIM_NOW) parts.push(`now = ${SIM_NOW.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`);
  b.innerHTML = parts.join(" · ") + ' · <a href="./">exit</a>';
  document.body.prepend(b);
}
installSimBanner();

// ---------- Web Push subscribe ----------
//
// Standard Web Push API: registers our service worker, asks for permission,
// calls pushManager.subscribe() with our VAPID public key, POSTs the resulting
// subscription to the Worker.

async function installPushSubscribe() {
  if (SIM_NAME || SIM_NOW) return;
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  if (!VAPID_PUBLIC_KEY || VAPID_PUBLIC_KEY.startsWith("REPLACE_WITH")) return;

  const btn = document.getElementById("push-btn");
  if (!btn) return;

  let reg;
  try {
    reg = await navigator.serviceWorker.register("./sw.js");
  } catch (e) {
    console.error("SW register failed", e);
    return;
  }

  const refresh = async () => {
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      btn.textContent = "🔔 Subscribed — you'll get a push each lap";
      btn.classList.add("subscribed");
    } else {
      btn.textContent = "🔔 Get notified when Matt summits";
      btn.classList.remove("subscribed");
    }
    btn.hidden = false;
  };

  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        await fetch(PUSH_WORKER_URL + "/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: existing.endpoint }),
        });
        await existing.unsubscribe();
      } else {
        const perm = await Notification.requestPermission();
        if (perm !== "granted") return;
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
        const json = sub.toJSON();
        await fetch(PUSH_WORKER_URL + "/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            endpoint: json.endpoint,
            keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
          }),
        });
      }
      await refresh();
    } catch (e) {
      console.error("push subscribe failed", e);
      alert("Push subscription failed: " + (e.message || e));
    } finally {
      btn.disabled = false;
    }
  };

  await refresh();
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

installPushSubscribe();

// ---------- main loop ----------

async function tick() {
  try {
    const [cfgRows, lapRows] = await Promise.all([
      fetchCsv(CONFIG_CSV_URL),
      fetchCsv(LAPS_CSV_URL),
    ]);
    const cfg  = configFromCsv(cfgRows);
    const laps = lapsFromCsv(lapRows);
    render(cfg, laps);
  } catch (e) {
    console.error(e);
    document.getElementById("updated").textContent = "fetch error — retrying";
  }
}

tick();
setInterval(tick, REFRESH_MS);
document.addEventListener("click", tick);
