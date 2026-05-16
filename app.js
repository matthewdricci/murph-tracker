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
//
// Semantic model:
//   - A row with note='start' marks the workout start.
//   - All other rows are segments (mile-1 = 1, rounds = 2..21, mile-2 = 22).
//   - HERO + CHART only count the 20 Cindy rounds — the "chip away" surface.
//     Miles are still logged and labeled, but they're bookends, not the count.
//   - Cutoff = start + target_duration_min (full workout window, miles included).
const CONFIG = {
  // Single anchor: by this mark, Mile-1 + all 20 rounds should be done.
  // Mile-2 happens after with no deadline pressure — it's just the cooldown run.
  rounds_target_min:   50,
  total_segments:      22,
  hero_total:          20,
  hero_offset:         1,
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

// Map segment count → human phase label (shown as subtitle).
function phaseLabel(startRow, segmentsDone, totalSegments) {
  if (!startRow && segmentsDone === 0) return "awaiting start tap";
  if (segmentsDone === 0)               return "in Mile 1";
  if (segmentsDone === 1)               return "Mile 1 done · awaiting Round 1";
  if (segmentsDone >= 2 && segmentsDone <= 20) {
    const justFinished = segmentsDone - 1;
    return `Round ${justFinished} done · ${20 - justFinished} rounds to go`;
  }
  if (segmentsDone === 21)              return "All 20 rounds done · in Mile 2";
  if (segmentsDone >= totalSegments)    return "FINISHED 🎉";
  return "";
}

// ---------- render ----------

let chart = null;

function render(cfg, allRows) {
  const now = getNow();

  // Split start markers from segment taps.
  const startRow = allRows.find(r => r.note === 'start') || null;
  const segments = allRows.filter(r => r.note !== 'start');

  const start = startRow ? startRow.t : (segments[0]?.t || null);
  // Single cutoff = round target. Mile-2 is post-target cooldown, no deadline.
  const cutoff = start ? new Date(start.getTime() + cfg.rounds_target_min * 60_000) : null;

  // Total in the hero/chart is rounds-only (cfg.hero_total = 20).
  // "done" here = rounds done. Mile-1 doesn't count (offset=1); mile-2 happens after the count hits 20.
  const segmentsDone = segments.length;
  const total = cfg.hero_total;
  const done = Math.max(0, Math.min(total, segmentsDone - cfg.hero_offset));
  const remainingLaps = Math.max(0, total - done);
  const elapsedMs = start ? (now - start) : null;
  const cutoffMs  = cutoff ? (cutoff - now) : null;

  updateStartButton(!!startRow);
  document.getElementById("title").textContent = `Murph — ${cfg.athlete_name}`;
  document.getElementById("subtitle").textContent = phaseLabel(startRow, segmentsDone, cfg.total_segments);
  document.getElementById("laps-done").textContent  = done;
  document.getElementById("laps-total").textContent = total;
  document.getElementById("elevation").hidden = true;

  const pct = total ? (done / total) * 100 : 0;
  document.getElementById("percent").textContent = pct.toFixed(1) + "%";
  document.getElementById("progress-bar").style.width = Math.min(100, pct) + "%";

  document.getElementById("elapsed").textContent   = start ? fmtDur(Math.max(0, elapsedMs)) : "awaiting start tap";
  // "TO ROUND TARGET" — countdown to the 50-min mark. Goes negative when over (shown as "+Xm over").
  document.getElementById("remaining").textContent =
    !start            ? "—"
    : cutoffMs >  0   ? fmtDur(cutoffMs)
    :                   "+" + fmtDur(Math.abs(cutoffMs)) + " over";

  // Pace math operates on the rounds-only count.
  const budgetMs = remainingLaps > 0 && cutoffMs != null && cutoffMs > 0 ? cutoffMs / remainingLaps : null;
  const actualMs = done > 0 && elapsedMs > 0 ? elapsedMs / done : null;

  // BUFFER
  const bufferBox  = document.getElementById("buffer-box");
  const bufferEl   = document.getElementById("buffer");
  const bufferNote = document.getElementById("buffer-note");
  bufferBox.classList.remove("good", "bad");
  if (!start) {
    bufferEl.textContent = "—";
    bufferNote.textContent = "tap Start to begin";
  } else if (done === 0 || actualMs == null) {
    bufferEl.textContent = "—";
    bufferNote.textContent = "starts updating after Round 1";
  } else if (remainingLaps === 0) {
    bufferEl.textContent = "RDS DONE";
    bufferBox.classList.add("good");
    bufferNote.textContent = "all 20 rounds at " + segments[segments.length-1].t.toLocaleString([], { hour: "numeric", minute: "2-digit" });
  } else if (cutoffMs <= 0) {
    bufferEl.textContent = "TARGET PASSED";
    bufferBox.classList.add("bad");
    bufferNote.textContent = `${done}/${total} rounds completed`;
  } else {
    const projectedFinish = new Date(now.getTime() + remainingLaps * actualMs);
    const buf = cutoff - projectedFinish;
    bufferEl.textContent = (buf >= 0 ? "+" : "−") + fmtDur(Math.abs(buf)) + (buf >= 0 ? " ahead" : " behind");
    bufferBox.classList.add(buf >= 0 ? "good" : "bad");
    bufferNote.textContent = "projected rounds-done " + projectedFinish.toLocaleString([], { hour: "numeric", minute: "2-digit" });
  }

  // NEXT ROUND DUE BY
  const dueEl  = document.getElementById("due-by");
  const dueNote = document.getElementById("due-note");
  if (!start) {
    dueEl.textContent = "—";
    dueNote.textContent = "awaiting start tap";
  } else if (remainingLaps === 0) {
    dueEl.textContent = "—";
    dueNote.textContent = "all rounds complete";
  } else if (cutoffMs <= 0) {
    dueEl.textContent = "—";
    dueNote.textContent = "target passed";
  } else {
    const dueAt = new Date(now.getTime() + budgetMs);
    dueEl.textContent = dueAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    dueNote.textContent = `${fmtDur(budgetMs)} from now — round budget`;
  }

  // Last segment + status (uses raw segments, not rounds-only — so mile taps register)
  if (segmentsDone > 0) {
    const last = segments[segments.length - 1].t;
    const since = now - last;
    document.getElementById("last-summit").textContent = fmtDur(since) + " ago";
    const isResting = since > REST_MIN * 60_000;
    document.getElementById("status").textContent = isResting ? `Resting — ${fmtDur(since)}` : "Active";
  } else {
    document.getElementById("last-summit").textContent = "—";
    document.getElementById("status").textContent = start ? "in Mile 1" : "awaiting start tap";
  }

  // For burn-down chart color: are we currently ahead on rounds?
  let ahead = null;
  if (start && cutoff && done > 0 && cutoffMs > 0) {
    const requiredRemaining = total * (cutoff - now) / (cutoff - start);
    const actualRemaining   = total - done;
    ahead = actualRemaining < requiredRemaining;
  }

  renderDupes(segments);
  renderChart(start, cutoff, total, segments, cfg.hero_offset, now, ahead);

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

function renderChart(start, cutoff, total, segments, heroOffset, now, ahead) {
  const ctx = document.getElementById("chart");

  if (!start || !cutoff) {
    if (chart) { chart.data.datasets = []; chart.update("none"); }
    return;
  }

  // Burn-down: stairsteps DOWN from total (rounds remaining) toward 0.
  // Only the round taps (segments[heroOffset..heroOffset+total-1]) drop the line.
  // Mile-1 tap (segment 0) and Mile-2 tap (segment 21) DON'T drop the line — bookends.
  let remaining = total;
  const stepPts = [{ x: start, y: remaining }];
  segments.forEach((seg, i) => {
    const isRoundTap = i >= heroOffset && i < heroOffset + total;
    if (isRoundTap) {
      // Hold the previous value to this tap, then drop by 1.
      stepPts.push({ x: seg.t, y: remaining });
      remaining = remaining - 1;
      stepPts.push({ x: seg.t, y: remaining });
    } else {
      // Mile bookends — line stays flat, but anchor a point at this timestamp.
      stepPts.push({ x: seg.t, y: remaining });
    }
  });
  if (segments.length > 0 && now > segments[segments.length - 1].t) {
    stepPts.push({ x: now, y: remaining });
  }

  // Required pace: diagonal from (start, total) → (cutoff, 0). Hitting zero = done in time.
  const required = [{ x: start, y: total }, { x: cutoff, y: 0 }];

  // Color by ahead/behind. In burn-down, "ahead" = curve is BELOW the diagonal (less remaining than expected).
  const remainingColor = ahead === true  ? "#4ade80"
                       : ahead === false ? "#ef4444"
                                         : "#ffb648";
  const remainingFill  = ahead === true  ? "rgba(74, 222, 128, 0.15)"
                       : ahead === false ? "rgba(239, 68, 68, 0.15)"
                                         : "rgba(255, 182, 72, 0.15)";

  const datasets = [
    {
      label: "Required",
      data: required,
      borderColor: "rgba(152, 162, 175, 0.7)",
      borderDash: [6, 6],
      borderWidth: 2,
      pointRadius: 0,
      fill: false,
      tension: 0,
    },
    {
      label: "Remaining",
      data: stepPts,
      borderColor: remainingColor,
      backgroundColor: remainingFill,
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
        legend: { display: false },
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

// ---------- Start button ----------
//
// One-time tap at GO. POSTs /lap with note='start'. Auth secret prompted once
// then cached in localStorage. Button is shown only when no start row exists.

const startBtn = document.getElementById("start-btn");
let lastStartShown = null;  // last state we drove the button to, to avoid flicker

function updateStartButton(hasStart) {
  if (!startBtn) return;
  if (hasStart === lastStartShown) return;
  lastStartShown = hasStart;
  startBtn.hidden = !!hasStart;
}

async function onStartClick() {
  let secret = localStorage.getItem("notify_secret");
  if (!secret) {
    secret = prompt("Paste NOTIFY_SECRET (one-time, stored locally on this device):");
    if (!secret) return;
    localStorage.setItem("notify_secret", secret.trim());
    secret = secret.trim();
  }

  startBtn.disabled = true;
  startBtn.textContent = "Starting…";
  try {
    const r = await fetch(WORKER_URL + "/lap", {
      method: "POST",
      headers: { "Authorization": "Bearer " + secret, "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "murph",
        note: "start",
        push: true,
        push_total: 22,
        push_title: "Murph",
        push_body: "Murph started 🏃",
        push_url: location.href,
      }),
    });
    if (!r.ok) {
      const txt = await r.text();
      if (r.status === 401) {
        localStorage.removeItem("notify_secret");
        alert("Auth failed — secret was wrong. Tap Start again to re-enter.");
      } else {
        alert("Start failed (" + r.status + "): " + txt);
      }
      return;
    }
    await tick();  // immediate refresh
  } catch (e) {
    alert("Start failed: " + (e.message || e));
  } finally {
    startBtn.disabled = false;
    startBtn.textContent = "▶ Start Murph";
  }
}

if (startBtn) startBtn.addEventListener("click", onStartClick);

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
