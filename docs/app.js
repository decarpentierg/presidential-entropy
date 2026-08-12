"use strict";

// ---- config ---------------------------------------------------------------
const COLORS = {
  entropy: "#38bdf8",
  cand: "#c084fc",
  sum: "#34d399",
  grid: "#222b36",
  text: "#e6edf3",
  muted: "#8b949e",
  panel: "#161b22",
  other: "#5b6673",
};
const START = Date.UTC(2026, 0, 1); // site starts 01/01/2026
const LN2 = Math.log(2);
const LN10 = Math.log(10);
const OTHER = "Other";

const MODES = {
  neff: { title: "Effective number of candidates", fn: (h) => Math.exp(h) },
  bits: { title: "Entropy (bits)", fn: (h) => h / LN2 },
  nats: { title: "Entropy (nats)", fn: (h) => h },
  dits: { title: "Entropy (dits / bans)", fn: (h) => h / LN10 },
};

// Candidates ordered left → right on the political spectrum; the hue/sat of the
// family is shared, lightness separates members within it. Editable by hand —
// anyone Polymarket adds later that is missing here lands at the right end in
// neutral grey.
const SPECTRUM = [
  { family: "LFI / radical left", hue: 352, sat: 68, members: [
    "Jean-Luc Mélenchon", "Mathilde Panot", "Manuel Bompard", "Clémence Guetté",
    "Juan Branco", "Clémentine Autain", "François Ruffin"] },
  // Castets is unaffiliated (NFP's 2024 PM pick); parked here as "left of the PS".
  { family: "PCF / other left", hue: 10, sat: 60, members: ["Fabien Roussel", "Lucie Castets"] },
  { family: "Greens", hue: 145, sat: 50, members: ["Marine Tondelier", "Yannick Jadot"] },
  { family: "PS / social-democrats", hue: 325, sat: 55, members: [
    "Olivier Faure", "Karim Bouamrane", "Carole Delga", "Ségolène Royal",
    "François Hollande", "Bernard Cazeneuve", "Raphaël Glucksmann"] },
  { family: "Centre / macronie", hue: 40, sat: 88, members: [
    "François Bayrou", "Élisabeth Borne", "Yaël Braun-Pivet", "Gabriel Attal",
    "Jean Castex", "Sébastien Lecornu", "Édouard Philippe", "Gérald Darmanin"] },
  { family: "LR / right", hue: 196, sat: 72, members: [
    "Dominique de Villepin", "Michel Barnier", "François Baroin", "Valérie Pécresse",
    "Xavier Bertrand", "David Lisnard", "Laurent Wauquiez", "Bruno Retailleau"] },
  { family: "Souverainists", hue: 268, sat: 32, members: [
    "Nicolas Dupont-Aignan", "François Asselineau"] },
  { family: "Far right", hue: 228, sat: 58, members: [
    "Marine Le Pen", "Jordan Bardella", "Marion Maréchal", "Éric Zemmour", "Sarah Knafo"] },
];

const COLOR_OF = {}; // name -> css colour
const FAMILY_OF = {}; // name -> family label
const SPECTRUM_RANK = {}; // name -> left-to-right position
SPECTRUM.forEach((f) => {
  f.members.forEach((name, i) => {
    // Spread both hue and lightness inside the family — lightness alone left
    // same-family heavyweights (Attal / Philippe) nearly indistinguishable.
    const k = f.members.length === 1 ? 0.5 : i / (f.members.length - 1);
    const l = 72 - 32 * k;
    const h = (f.hue - 13 + 26 * k + 360) % 360;
    COLOR_OF[name] = `hsl(${h}, ${f.sat}%, ${l}%)`;
    FAMILY_OF[name] = f.family;
    SPECTRUM_RANK[name] = Object.keys(SPECTRUM_RANK).length;
  });
});

const state = {
  tab: "entropy",
  mode: "neff",
  range: "3m",
  showCand: false,
  showSum: false,
  scale: "linear",
  topN: 10,
  snapIdx: null, // index into CAND.dates, null = latest in range
};
let DATA = null; // { dates:[Date], nats:[], cand:[], sum:[] } filtered to >= START
let CAND = null; // { dates:[Date], names:[ordered], p:{name:[...]} }
let candLoading = null;
let playTimer = null;

// ---- helpers --------------------------------------------------------------
function rangeStart(lastMs) {
  const day = 86400000;
  switch (state.range) {
    case "week": return Math.max(START, lastMs - 7 * day);
    case "1m":   return Math.max(START, lastMs - 30 * day);
    case "3m":   return Math.max(START, lastMs - 91 * day);
    case "1y":   return Math.max(START, lastMs - 365 * day);
    default:     return START;
  }
}

// min/max of an array over the visible index window, ignoring nulls
function extent(arr, lo, hi) {
  let min = Infinity, max = -Infinity;
  for (let i = lo; i <= hi; i++) {
    const v = arr[i];
    if (v === null || v === undefined || Number.isNaN(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === Infinity) return null;
  return [min, max];
}

// Like extent(), but trims the same fraction off both tails of the series, so a
// one-row artefact cannot set the axis. Markets opening mid-race quote at an
// arbitrary price for their first timestamp (five of them at 14.3% each on
// 14 Jul 2026), which throws the folded "Other" curve to 75% for one point and
// squashes everything else into the bottom third of the plot.
function robustRange(arr, lo, hi, q = 0.005) {
  const vals = [];
  for (let i = lo; i <= hi; i++) {
    const v = arr[i];
    if (v === null || v === undefined || Number.isNaN(v)) continue;
    vals.push(v);
  }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  const k = Math.floor(q * (vals.length - 1));
  return [vals[k], vals[vals.length - 1 - k]];
}

function pad(range, frac = 0.08) {
  if (!range) return null;
  let [lo, hi] = range;
  if (lo === hi) { const d = Math.abs(lo) || 1; return [lo - d * 0.1, hi + d * 0.1]; }
  const m = (hi - lo) * frac;
  return [lo - m, hi + m];
}

// indices [lo,hi] of dates within [startMs, endMs]
function windowIndices(dates, startMs, endMs) {
  let lo = 0, hi = dates.length - 1;
  while (lo < dates.length && dates[lo].getTime() < startMs) lo++;
  while (hi >= 0 && dates[hi].getTime() > endMs) hi--;
  return [Math.max(0, lo), Math.max(0, hi)];
}

// visible window of the candidate series for the current range
function candWindow() {
  const last = CAND.dates[CAND.dates.length - 1].getTime();
  return windowIndices(CAND.dates, rangeStart(last), last);
}

// All candidates ranked by their probability at one instant, highest first.
// Candidates with no market yet sort last (null -> -1).
function rankedAt(i) {
  return CAND.names
    .filter((n) => n !== OTHER)
    .map((n) => [n, CAND.p[n][i] ?? -1])
    .sort((a, b) => b[1] - a[1]);
}

// The N candidates to draw. The time series views pin the set to the latest
// point so the curves keep a stable identity across the whole window; the
// snapshot re-picks it at whatever instant is displayed.
function topAt(i) {
  return rankedAt(i).slice(0, state.topN).map(([n]) => n);
}

// Everything not drawn individually — the synthetic residual plus the
// candidates below the top-N cut — folded into one grey band so the shares
// still sum to 1.
function otherSeries(kept) {
  const keptSet = new Set(kept);
  const rest = CAND.names.filter((n) => n !== OTHER && !keptSet.has(n));
  return CAND.dates.map((_, i) => {
    let s = CAND.p[OTHER][i] || 0;
    for (const n of rest) s += CAND.p[n][i] || 0;
    return s;
  });
}

// Same idea for a single instant: every column of the payload sums to 1, so
// whatever the drawn bars leave over is the grey bar.
function otherAt(i, rows) {
  return Math.max(0, 1 - rows.reduce((s, r) => s + r.v, 0));
}

// Upper bound for the snapshot's probability axis over the whole visible
// window — the biggest single candidate, or the biggest Other bar. Fixing the
// axis on the window (rather than on the current instant) keeps it from
// twitching while the animation plays. Memoised because snapshotChart re-runs
// on every frame and this walks the window.
const snapMaxCache = {};
function snapshotMax(lo, hi) {
  const key = `${lo}:${hi}:${state.topN}`;
  if (snapMaxCache[key] !== undefined) return snapMaxCache[key];
  let max = 0;
  for (let i = lo; i <= hi; i++) {
    const ranked = rankedAt(i);
    let sum = 0;
    for (let k = 0; k < ranked.length && k < state.topN; k++) sum += Math.max(ranked[k][1], 0);
    max = Math.max(max, Math.max(ranked[0] ? ranked[0][1] : 0, 0), 1 - sum);
  }
  snapMaxCache[key] = max;
  return max;
}

function colorOf(name) {
  return name === OTHER ? COLORS.other : COLOR_OF[name] || COLORS.other;
}

// Polymarket adds candidates over time; anyone not in SPECTRUM yet sorts to the
// right-hand end in neutral grey. Going through this (rather than indexing
// SPECTRUM_RANK directly) keeps a missing name from returning NaN from a sort
// comparator, which silently scrambles the whole political ordering.
function rank(name) {
  return SPECTRUM_RANK[name] ?? 999;
}

const dateFmt = { year: "numeric", month: "short", day: "numeric" };

// ---- entropy chart --------------------------------------------------------
function entropyTraces() {
  const entropyY = DATA.nats.map((h) => (h === null ? null : MODES[state.mode].fn(h)));
  return [
    {
      x: DATA.dates, y: entropyY, name: MODES[state.mode].title,
      type: "scatter", mode: "lines", line: { color: COLORS.entropy, width: 2 },
      yaxis: "y", hovertemplate: "%{x|%b %d, %Y}<br>%{y:.3f}<extra></extra>",
    },
    {
      x: DATA.dates, y: DATA.cand, name: "Number of candidates",
      type: "scatter", mode: "lines", line: { color: COLORS.cand, width: 1.6, shape: "hv" },
      yaxis: "y2", visible: state.showCand, hovertemplate: "%{y}<extra>candidates</extra>",
    },
    {
      x: DATA.dates, y: DATA.sum, name: "Sum of probabilities",
      type: "scatter", mode: "lines", line: { color: COLORS.sum, width: 1.4 },
      yaxis: "y3", visible: state.showSum, hovertemplate: "%{y:.3f}<extra>sum of probs</extra>",
    },
  ];
}

function entropyLayout() {
  const last = DATA.dates[DATA.dates.length - 1].getTime();
  const startMs = rangeStart(last);
  const [lo, hi] = windowIndices(DATA.dates, startMs, last);

  // entropy y-range for visible window in the current mode
  const eVals = [];
  for (let i = lo; i <= hi; i++) {
    const h = DATA.nats[i];
    if (h !== null) eVals.push(MODES[state.mode].fn(h));
  }
  const eRange = pad(eVals.length ? [Math.min(...eVals), Math.max(...eVals)] : null);

  // Reserve room on the right for each enabled overlay axis. Axis *titles* are
  // omitted (the checkboxes already label each curve by colour), so each axis
  // only needs space for its tick numbers.
  const rightAxes = (state.showCand ? 1 : 0) + (state.showSum ? 1 : 0);
  const domainRight = rightAxes === 0 ? 1 : rightAxes === 1 ? 0.91 : 0.83;
  const sumPos = state.showCand ? domainRight + 0.09 : domainRight;

  return {
    ...baseLayout(),
    hovermode: "x unified",
    xaxis: {
      ...dateAxis(startMs, last),
      domain: [0, domainRight],
    },
    yaxis: {
      title: { text: MODES[state.mode].title, font: { color: COLORS.entropy } },
      range: eRange || undefined,
      gridcolor: COLORS.grid, zeroline: false,
      tickfont: { color: COLORS.entropy }, linecolor: COLORS.grid,
    },
    yaxis2: {
      overlaying: "y", side: "right", anchor: "x",
      showgrid: false, zeroline: false,
      tickfont: { color: COLORS.cand }, linecolor: COLORS.cand, tickcolor: COLORS.cand,
      visible: state.showCand,
      range: pad(extent(DATA.cand, lo, hi), 0.15) || undefined,
    },
    yaxis3: {
      overlaying: "y", side: "right", anchor: "free", position: sumPos,
      showgrid: false, zeroline: false,
      tickfont: { color: COLORS.sum }, linecolor: COLORS.sum, tickcolor: COLORS.sum,
      visible: state.showSum,
      range: pad(extent(DATA.sum, lo, hi), 0.15) || undefined,
    },
  };
}

function baseLayout() {
  return {
    paper_bgcolor: COLORS.panel,
    plot_bgcolor: COLORS.panel,
    font: { color: COLORS.text, family: "inherit" },
    margin: { l: 56, r: 14, t: 16, b: 40 },
    showlegend: false,
  };
}

function dateAxis(startMs, endMs) {
  return {
    type: "date",
    range: [new Date(startMs), new Date(endMs)],
    gridcolor: COLORS.grid, zeroline: false,
    linecolor: COLORS.grid, tickcolor: COLORS.grid,
  };
}

// ---- candidate charts -----------------------------------------------------
function linesChart() {
  const [lo, hi] = candWindow();
  const kept = topAt(hi);
  // Drawn in political order so the legend reads left → right.
  const ordered = kept.slice().sort((a, b) => rank(a) - rank(b));
  const traces = ordered.map((name) => ({
    x: CAND.dates, y: CAND.p[name], name,
    type: "scatter", mode: "lines",
    line: { color: colorOf(name), width: 1.8 },
    hovertemplate: "%{y:.1%}<extra>" + name + "</extra>",
  }));
  const otherY = otherSeries(kept);
  traces.push({
    x: CAND.dates, y: otherY, name: OTHER,
    type: "scatter", mode: "lines",
    line: { color: COLORS.other, width: 1.4, dash: "dot" },
    hovertemplate: "%{y:.1%}<extra>Other</extra>",
  });

  // Frame the axis on the visible window, discarding each series' outliers.
  // Plotly's own autorange would look at the whole series (including dates
  // outside the range) and at every spike in it.
  const bounds = [...kept.map((n) => robustRange(CAND.p[n], lo, hi)), robustRange(otherY, lo, hi)]
    .filter(Boolean);
  const max = bounds.length ? Math.max(...bounds.map((b) => b[1])) : 1;

  const layout = {
    ...baseLayout(),
    showlegend: true,
    legend: { orientation: "h", y: -0.14, font: { size: 11 } },
    margin: { l: 56, r: 14, t: 16, b: 74 },
    hovermode: "closest",
    xaxis: dateAxis(CAND.dates[lo].getTime(), CAND.dates[hi].getTime()),
    yaxis: {
      title: { text: "Probability" },
      type: state.scale === "log" ? "log" : "linear",
      tickformat: state.scale === "log" ? ".1%" : ".0%",
      dtick: state.scale === "log" ? "D2" : undefined, // 1-2-5 per decade, not every minor tick
      gridcolor: COLORS.grid, zeroline: false, linecolor: COLORS.grid,
      range: [0, max * 1.08],
    },
  };
  if (state.scale === "log" && bounds.length) {
    // A log axis cannot start at zero; frame it on the visible values instead.
    const min = Math.max(1e-4, Math.min(...bounds.map((b) => (b[0] > 0 ? b[0] : b[1]))));
    layout.yaxis.range = [Math.log10(min * 0.7), Math.log10(max * 1.4)];
  }
  return [traces, layout];
}

function stackedChart() {
  const [lo, hi] = candWindow();
  const kept = topAt(hi);
  const ordered = kept.slice().sort((a, b) => rank(a) - rank(b));
  // Bottom-to-top = left-to-right on the spectrum, with the grey residual
  // pinned on top, outside the political ordering.
  const traces = ordered.map((name) => ({
    x: CAND.dates, y: CAND.p[name], name,
    type: "scatter", mode: "none", stackgroup: "one",
    fillcolor: colorOf(name),
    hovertemplate: "%{y:.1%}<extra>" + name + "</extra>",
  }));
  traces.push({
    x: CAND.dates, y: otherSeries(kept), name: OTHER,
    type: "scatter", mode: "none", stackgroup: "one",
    fillcolor: COLORS.other,
    hovertemplate: "%{y:.1%}<extra>Other</extra>",
  });

  return [traces, {
    ...baseLayout(),
    showlegend: true,
    legend: { orientation: "h", y: -0.14, font: { size: 11 }, traceorder: "reversed" },
    margin: { l: 56, r: 14, t: 16, b: 74 },
    hovermode: "closest",
    xaxis: dateAxis(CAND.dates[lo].getTime(), CAND.dates[hi].getTime()),
    yaxis: {
      title: { text: "Share of probability" },
      range: [0, 1], tickformat: ".0%",
      gridcolor: COLORS.grid, zeroline: false, linecolor: COLORS.grid,
    },
  }];
}

function snapshotChart() {
  const [lo, hi] = candWindow();
  const i = state.snapIdx === null ? hi : Math.min(Math.max(state.snapIdx, lo), hi);

  // The top N *at this instant* — the set itself changes as the slider moves.
  const rows = rankedAt(i)
    .slice(0, state.topN)
    .map(([name, v]) => ({ name, v: Math.max(v, 0) }))
    .reverse(); // Plotly draws the first bar at the bottom
  rows.unshift({ name: OTHER, v: otherAt(i, rows) }); // residual pinned at the bottom

  const trace = {
    type: "bar", orientation: "h",
    y: rows.map((r) => r.name),
    x: rows.map((r) => r.v),
    marker: { color: rows.map((r) => colorOf(r.name)) },
    hovertemplate: "%{y}: %{x:.1%}<extra></extra>",
    text: rows.map((r) => (r.v * 100).toFixed(1) + "%"),
    textposition: "auto",
    textfont: { color: COLORS.text, size: 11 },
  };

  const max = snapshotMax(lo, hi);
  const xaxis = {
    gridcolor: COLORS.grid, zeroline: false, linecolor: COLORS.grid,
    title: { text: "Probability" },
  };
  if (state.scale === "log") {
    xaxis.type = "log";
    xaxis.range = [Math.log10(0.003), Math.log10(max * 1.6)];
    xaxis.tickformat = ".1%";
    xaxis.dtick = "D2"; // 1-2-5 per decade, not every minor tick
  } else {
    xaxis.range = [0, max * 1.12];
    xaxis.tickformat = ".0%";
  }

  return [[trace], {
    ...baseLayout(),
    margin: { l: 160, r: 24, t: 16, b: 44 },
    bargap: 0.25,
    xaxis,
    yaxis: { automargin: true, tickfont: { size: 11 }, linecolor: COLORS.grid },
  }];
}

// ---- render ---------------------------------------------------------------
function render() {
  let traces, layout;
  if (state.tab === "entropy") {
    traces = entropyTraces();
    layout = entropyLayout();
  } else if (!CAND) {
    return; // still loading; load() re-renders when done
  } else if (state.tab === "lines") {
    [traces, layout] = linesChart();
  } else if (state.tab === "stacked") {
    [traces, layout] = stackedChart();
  } else {
    [traces, layout] = snapshotChart();
    syncSnapControls();
  }
  Plotly.react("chart", traces, layout, { responsive: true, displayModeBar: false });
}

// keep the date slider bounds/label in step with the range + data
function syncSnapControls() {
  const [lo, hi] = candWindow();
  const slider = document.getElementById("snap");
  const i = state.snapIdx === null ? hi : Math.min(Math.max(state.snapIdx, lo), hi);
  slider.min = lo;
  slider.max = hi;
  slider.value = i;
  document.getElementById("snap-date").textContent =
    CAND.dates[i].toLocaleString(undefined, { ...dateFmt, hour: "2-digit", minute: "2-digit" });
}

function showControls() {
  document.querySelectorAll("[data-tabs]").forEach((el) => {
    el.style.display = el.dataset.tabs.split(" ").includes(state.tab) ? "" : "none";
  });
}

// ---- controls -------------------------------------------------------------
function segmented(id, key, after) {
  document.querySelectorAll(`#${id} button`).forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll(`#${id} button`).forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      state[key] = b.dataset[key];
      if (after) after();
      render();
    });
  });
}

function stopPlay() {
  if (playTimer) { clearInterval(playTimer); playTimer = null; }
  document.getElementById("play").textContent = "▶";
}

function togglePlay() {
  if (playTimer) return stopPlay();
  document.getElementById("play").textContent = "❚❚";
  playTimer = setInterval(() => {
    const [lo, hi] = candWindow();
    const cur = state.snapIdx === null ? hi : state.snapIdx;
    state.snapIdx = cur >= hi ? lo : cur + Math.max(1, Math.round((hi - lo) / 120));
    render();
  }, 60);
}

function wire() {
  segmented("tab-switch", "tab", () => {
    stopPlay();
    showControls();
    if (state.tab !== "entropy") loadCandidates();
  });
  segmented("mode-switch", "mode");
  segmented("range-switch", "range", () => { state.snapIdx = null; });
  segmented("scale-switch", "scale");

  document.getElementById("toggle-candidates").addEventListener("change", (e) => {
    state.showCand = e.target.checked; render();
  });
  document.getElementById("toggle-sum").addEventListener("change", (e) => {
    state.showSum = e.target.checked; render();
  });
  document.getElementById("topn").addEventListener("input", (e) => {
    state.topN = Number(e.target.value);
    document.getElementById("topn-value").textContent = state.topN;
    render();
  });
  document.getElementById("snap").addEventListener("input", (e) => {
    stopPlay();
    state.snapIdx = Number(e.target.value);
    render();
  });
  document.getElementById("play").addEventListener("click", togglePlay);
  showControls();
}

// ---- load -----------------------------------------------------------------
// Fetched only when a candidate view is first opened — it is ~5x the size of
// history.json and the entropy view does not need it.
function loadCandidates() {
  if (CAND || candLoading) return candLoading;
  candLoading = fetch("data/candidates.json", { cache: "no-cache" })
    .then((r) => r.json())
    .then((raw) => {
      const dates = [], keep = [];
      raw.grid.forEach((s, i) => {
        const ms = s * 1000;
        if (ms < START) return;
        dates.push(new Date(ms));
        keep.push(i);
      });
      const p = {};
      for (const [name, row] of Object.entries(raw.candidates)) {
        p[name] = keep.map((i) => row[i]);
      }
      // Spectrum order, with anyone missing from SPECTRUM appended at the end.
      const names = Object.keys(p).filter((n) => n !== OTHER)
        .sort((a, b) => rank(a) - rank(b));
      const unplaced = names.filter((n) => !(n in SPECTRUM_RANK));
      if (unplaced.length) console.warn("Not in SPECTRUM, shown last in grey:", unplaced);
      CAND = { dates, names, p };
      render();
    });
  return candLoading;
}

async function load() {
  const res = await fetch("data/history.json", { cache: "no-cache" });
  const raw = await res.json();

  const dates = [], nats = [], cand = [], sum = [];
  for (let i = 0; i < raw.grid.length; i++) {
    const ms = raw.grid[i] * 1000;
    if (ms < START) continue; // site starts 01/01/2026
    dates.push(new Date(ms));
    nats.push(raw.entropy_nats[i]);
    cand.push(raw.n_candidates[i]);
    sum.push(raw.sum_probs[i]);
  }
  DATA = { dates, nats, cand, sum };

  const gen = document.getElementById("generated");
  if (gen && raw.generated_at) {
    gen.textContent = "data as of " + new Date(raw.generated_at).toLocaleString();
  }

  wire();
  render();
}

load().catch((err) => {
  document.getElementById("chart").innerHTML =
    '<p style="padding:24px;color:#8b949e">Failed to load data: ' + err + "</p>";
});
