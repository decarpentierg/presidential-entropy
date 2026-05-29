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
};
const START = Date.UTC(2026, 0, 1); // site starts 01/01/2026
const LN2 = Math.log(2);
const LN10 = Math.log(10);

const MODES = {
  bits: { title: "Entropy (bits)", fn: (h) => h / LN2 },
  nats: { title: "Entropy (nats)", fn: (h) => h },
  dits: { title: "Entropy (dits / bans)", fn: (h) => h / LN10 },
  neff: { title: "Effective number of candidates", fn: (h) => Math.exp(h) },
};

const state = { mode: "bits", range: "all", showCand: false, showSum: false };
let DATA = null; // { dates:[Date], nats:[], cand:[], sum:[] } filtered to >= START

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

function pad(range, frac = 0.08) {
  if (!range) return null;
  let [lo, hi] = range;
  if (lo === hi) { const d = Math.abs(lo) || 1; return [lo - d * 0.1, hi + d * 0.1]; }
  const m = (hi - lo) * frac;
  return [lo - m, hi + m];
}

// indices [lo,hi] of dates within [startMs, endMs]
function windowIndices(startMs, endMs) {
  const d = DATA.dates;
  let lo = 0, hi = d.length - 1;
  while (lo < d.length && d[lo].getTime() < startMs) lo++;
  while (hi >= 0 && d[hi].getTime() > endMs) hi--;
  return [Math.max(0, lo), Math.max(0, hi)];
}

// ---- chart ----------------------------------------------------------------
function buildTraces() {
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

function buildLayout() {
  const last = DATA.dates[DATA.dates.length - 1].getTime();
  const startMs = rangeStart(last);
  const [lo, hi] = windowIndices(startMs, last);

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

  const layout = {
    paper_bgcolor: COLORS.panel,
    plot_bgcolor: COLORS.panel,
    font: { color: COLORS.text, family: "inherit" },
    margin: { l: 56, r: 14, t: 16, b: 40 },
    showlegend: false,
    hovermode: "x unified",
    xaxis: {
      type: "date",
      range: [new Date(startMs), new Date(last)],
      domain: [0, domainRight],
      gridcolor: COLORS.grid, zeroline: false,
      linecolor: COLORS.grid, tickcolor: COLORS.grid,
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
  return layout;
}

function render() {
  Plotly.react("chart", buildTraces(), buildLayout(), {
    responsive: true,
    displayModeBar: false,
  });
}

// ---- controls -------------------------------------------------------------
function wire() {
  document.querySelectorAll("#mode-switch button").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll("#mode-switch button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      state.mode = b.dataset.mode;
      render();
    });
  });
  document.querySelectorAll("#range-switch button").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll("#range-switch button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      state.range = b.dataset.range;
      render();
    });
  });
  document.getElementById("toggle-candidates").addEventListener("change", (e) => {
    state.showCand = e.target.checked; render();
  });
  document.getElementById("toggle-sum").addEventListener("change", (e) => {
    state.showSum = e.target.checked; render();
  });
}

// ---- load -----------------------------------------------------------------
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
