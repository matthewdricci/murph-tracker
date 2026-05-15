// Murph Test 2026 — Live segment tracker dashboard
//
// Rehearsal fork of ironhike-tracker. Same pipeline applied to a Murph workout
// on Saturday May 16, 2026. 22 segments: mile-1 + 20 Cindy rounds + mile-2.
//
// Backend: extended ironhike-push Cloudflare Worker. GET /laps?event=murph
// returns JSON; shortcut POSTs /lap. No Google Sheets, no Zapier, no CSV
// publish cache. Single source of truth in D1.

const WORKER_URL       = "https://ironhike-push.beyond-the-hudson-918.workers.dev";
const LAPS_API_URL     = WORKER_URL + "/laps?event=murph";
const VAPID_PUBLIC_KEY = "BF9wwg-Dj93wNjIPdXisxSNg5wJpzHVD62Jag-HttBRiS1RZ1VmQgMvo0kTLHeFSrV9F7ca2xT0-PTQ42YxVqR0";

const REFRESH_MS = 15_000;  // worker is real-time; tighter refresh OK
const REST_MIN   = 10;      // minutes between segments before status flips to "Resting"
const DUP_SEC    = 20;      // segments closer than this look like accidental double-taps

// Static config. No remote config tab anymore — these change rarely and live with the code.
// Semantic model: every tap = +1 segment. First tap's timestamp = start.
// Cutoff = start + target_duration_min. Done = laps.length.
const CONFIG = {
  target_duration_min: 90,
  total_laps:          22,
  athlete_name:        "Matt Ricci",
};

// ---------- time-travel (no sim files anymore) ----------
const params = new URLSearchParams(location.search);
let SIM_NOW = null;
if (params.get("simNow")) {
  const d = new Date(params.get("simNow"));
  if (!isNaN(d)) SIM_NOW = d;
}
function getNow() { return SIM_NOW ? new Date(SIM_NOW.getTime()) : new Date(); }

// ---------- data ----------

async function fetchLaps() {
  const r = await fetch(LAPS_API_URL + "&cachebust=" + Date.now());
  if (!r.ok) throw new Error("fetch " + LAPS_API_URL + " → " + r.status);
  const body = await r.json();
  return (body.laps || [])
    .map(row => ({ id: row.id, t: new Date(row.timestamp_iso), note: row.note || "" }))
    .filter(x => !isNaN(x.t))
    .sort((a, b) => a.t - b.t);
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

// ---------- render ----------

let chart = null;

function render(cfg, laps) {
  const now = getNow();
  const total = cfg.total_laps;
  const targetMs = cfg.target_duration_min * 60_000;

  // Semantic: every tap is a segment. Start = first tap's timestamp.
  const start = laps.length > 0 ? laps[0].t : null;
  const cutoff = start ? new Date(start.getTime() + targetMs) : null;

  const done = laps.length;
  const remainingLaps = Math.max(0, total - done);
  const elapsedMs = start ? (now - start) : null;
  const cutoffMs  = cutoff ? (cutoff - now) : null;

  document.getElementById("title").textContent = `Murph Test — ${cfg.athlete_name}`;
  document.getElementById("laps-done").textContent  = done;
  document.getElementById("laps-total").textContent = total;
  document.getElementById("elevation").hidden = true;

  const pct = total ? (done / total) * 100 : 0;
  document.getElementById("percent").textContent = pct.toFixed(1) + "%";
  document.getElementById("progress-bar").style.width = Math.min(100, pct) + "%";

  document.getElementById("elapsed").textContent   = start ? fmtDur(Math.max(0, elapsedMs)) : "awaiting first tap";
  document.getElementById("remaining").textContent = !start ? "—" : cutoffMs > 0 ? fmtDur(cutoffMs) : "TARGET PASSED";

  const budgetMs = remainingLaps > 0 && cutoffMs != null && cutoffMs > 0 ? cutoffMs / remainingLaps : null;
  const actualMs = done > 1 && elapsedMs > 0 ? elapsedMs / (done - 1) : null;
  // ^ pace uses (done - 1) intervals between done timestamps, not done.
  // At done=1 the elapsed is 0 (tap 1 IS the start), so no pace yet.

  // BUFFER
  const bufferBox  = document.getElementById("buffer-box");
  const bufferEl   = document.getElementById("buffer");
  const bufferNote = document.getElementById("buffer-note");
  bufferBox.classList.remove("good", "bad");
  if (!start) {
    bufferEl.textContent = "—";
    bufferNote.textContent = "tap to log first segment";
  } else if (done < 2 || actualMs == null) {
    bufferEl.textContent = "—";
    bufferNote.textContent = "starts updating after segment 2";
  } else if (remainingLaps === 0) {
    bufferEl.textContent = "FINISHED";
    bufferBox.classList.add("good");
    bufferNote.textContent = "at " + laps[laps.length-1].t.toLocaleString([], { hour: "numeric", minute: "2-digit" });
  } else if (cutoffMs <= 0) {
    bufferEl.textContent = "TARGET PASSED";
    bufferBox.classList.add("bad");
    bufferNote.textContent = `${done}/${total} segments completed`;
  } else {
    const projectedFinish = new Date(now.getTime() + remainingLaps * actualMs);
    const buf = cutoff - projectedFinish;
    bufferEl.textContent = (buf >= 0 ? "+" : "−") + fmtDur(Math.abs(buf)) + (buf >= 0 ? " ahead" : " behind");
    bufferBox.classList.add(buf >= 0 ? "good" : "bad");
    bufferNote.textContent = "projected finish " + projectedFinish.toLocaleString([], { hour: "numeric", minute: "2-digit" });
  }

  // NEXT SEGMENT DUE BY
  const dueEl  = document.getElementById("due-by");
  const dueNote = document.getElementById("due-note");
  if (!start) {
    dueEl.textContent = "—";
    dueNote.textContent = "awaiting first tap";
  } else if (remainingLaps === 0) {
    dueEl.textContent = "—";
    dueNote.textContent = "all segments complete";
  } else if (cutoffMs <= 0) {
    dueEl.textContent = "—";
    dueNote.textContent = "target passed";
  } else {
    const dueAt = new Date(now.getTime() + budgetMs);
    dueEl.textContent = dueAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    dueNote.textContent = `${fmtDur(budgetMs)} from now — your running budget`;
  }

  // Last segment + status
  if (done > 0) {
    const last = laps[laps.length - 1].t;
    const since = now - last;
    document.getElementById("last-summit").textContent = fmtDur(since) + " ago";
    const isResting = since > REST_MIN * 60_000;
    document.getElementById("status").textContent = isResting ? `Resting — ${fmtDur(since)}` : "Active";
  } else {
    document.getElementById("last-summit").textContent = "—";
    document.getElementById("status").textContent = "awaiting first tap";
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
    if (gap < DUP_SEC) pairs.push({ a: i, b: i + 1, gap, id: laps[i].id });
  }
  if (pairs.length === 0) { wrap.hidden = true; wrap.innerHTML = ""; return; }
  wrap.hidden = false;
  wrap.innerHTML = `
    <div class="k">POSSIBLE DUPLICATE${pairs.length > 1 ? "S" : ""}</div>
    <div class="v">${pairs.map(p => `row ${p.a} &amp; ${p.b} <span class="thin">(${p.gap.toFixed(0)}s apart, id ${p.id})</span>`).join("<br>")}</div>
    <div class="note">If accidental, POST {"id":${pairs[0].id}} to /lap/delete with the bearer token.</div>
  `;
}

function renderChart(start, cutoff, total, laps, now) {
  const ctx = document.getElementById("chart");

  if (!start || !cutoff) {
    if (chart) { chart.data.datasets = []; chart.update("none"); }
    return;
  }

  const stepPts = [{ x: start, y: 0 }];
  laps.forEach((lap, i) => {
    stepPts.push({ x: lap.t, y: i });
    stepPts.push({ x: lap.t, y: i + 1 });
  });
  if (laps.length > 0 && now > laps[laps.length - 1].t) {
    stepPts.push({ x: now, y: laps.length });
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
          time: { unit: "minute", stepSize: 15, displayFormats: { minute: "h:mm a" } },
          ticks: { color: "#98a2af", font: { size: 10 }, maxRotation: 0, autoSkipPadding: 16 },
          grid: { color: "#262c34" },
        },
        y: {
          min: 0,
          max: total,
          ticks: { color: "#98a2af", font: { size: 10 }, stepSize: total >= 30 ? 10 : 2 },
          grid: { color: "#262c34" },
        },
      },
    },
  });
}

function installSimBanner() {
  if (!SIM_NOW) return;
  const b = document.createElement("div");
  b.id = "sim-banner";
  b.innerHTML = `now = ${SIM_NOW.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · <a href="./">exit</a>`;
  document.body.prepend(b);
}
installSimBanner();

// ---------- Web Push subscribe ----------

async function installPushSubscribe() {
  if (SIM_NOW) return;
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  if (!VAPID_PUBLIC_KEY || VAPID_PUBLIC_KEY.startsWith("REPLACE_WITH")) return;

  const btn = document.getElementById("push-btn");
  if (!btn) return;

  let reg;
  try { reg = await navigator.serviceWorker.register("./sw.js"); }
  catch (e) { console.error("SW register failed", e); return; }

  const refresh = async () => {
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      btn.textContent = "🔔 Subscribed — you'll get a push each segment";
      btn.classList.add("subscribed");
    } else {
      btn.textContent = "🔔 Get notified each Murph segment";
      btn.classList.remove("subscribed");
    }
    btn.hidden = false;
  };

  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        await fetch(WORKER_URL + "/unsubscribe", {
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
        const j = sub.toJSON();
        await fetch(WORKER_URL + "/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth } }),
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
    const laps = await fetchLaps();
    render(CONFIG, laps);
  } catch (e) {
    console.error(e);
    document.getElementById("updated").textContent = "fetch error — retrying";
  }
}

tick();
setInterval(tick, REFRESH_MS);
document.addEventListener("click", tick);
