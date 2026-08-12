# Presidential Entropy

A tiny website tracking the **Shannon entropy** of Polymarket's implied probability
distribution over candidates for the **2027 French presidential election** — a single
measure of *how undecided the race is*, plotted over time.

Four views, switched by the tabs at the top:

- **Entropy** — the headline series. Units: **effective number of candidates** (`e^H`, default),
  bits, nats, or dits (bans). Overlays: total number of candidate markets, and the raw sum of
  probabilities (before renormalization).
- **Candidate lines** — each candidate's probability over time, linear or log scale.
- **Stacked shares** — the whole distribution as bands summing to 1, ordered left → right along
  the political spectrum.
- **Snapshot** — the distribution at one instant as ranked bars, with a date slider and a play
  button (bar-chart race).

**Range:** week / 1M / **3M** (default) / 1Y / all (from 1 Jan 2026).

The candidate views draw the N highest-probability candidates (`Candidates shown` slider, 3–36) —
ranked at the latest data point for the two time-series views, and at the displayed instant for
the snapshot, so its bars change membership as the slider moves. The rest, plus the synthetic
"Other" mass, fold into one grey band. Colours group candidates by political family — the ordering and the families are a
hand-curated list (`SPECTRUM` in `docs/app.js`), edit it there.

## How it works

**Data.** Two public, no-auth Polymarket APIs:
- *Gamma* (`gamma-api.polymarket.com`) — enumerate the event's live candidate markets
  (`slug=next-french-presidential-election`) and their "Yes" token ids.
- *CLOB* (`clob.polymarket.com/prices-history`) — per-token price history. We fetch both
  daily (`fidelity=1440`, full history back to ~Nov 2025) and hourly (`fidelity=60`, recent
  ~30 days) and merge them.

**Probability model.** Each candidate's probability is its "Yes" price. At each timestamp,
with `S = Σ pᵢ` over candidates that exist then:
- `S < 1` → add a synthetic **"Other"** atom of mass `1 − S`;
- `S ≥ 1` → renormalize the candidates by `S` (over-round from bid/ask spreads).

Entropy `H = −Σ pᵢ ln pᵢ` is computed over that distribution. The four units are transforms
of one another (`bits = nats/ln2`, `dits = nats/ln10`, `effective candidates = e^nats`).
*Limitation:* lumping all unnamed candidates into one "Other" atom slightly understates the
true diversity.

## Architecture (free, all-GitHub)

- `.github/workflows/update.yml` runs **hourly**, fetches + merges into
  `data/series.json` (raw per-candidate prices, source of truth — kept outside `docs/` so it
  is not published), recomputes the small `docs/data/history.json` and
  `docs/data/candidates.json`, and commits any changes.
  The merge preserves fine-grained hourly points permanently, even after they age out of
  Polymarket's hourly window.
- `docs/` is a static site (Plotly.js) served by **GitHub Pages**; the browser loads only the
  small derived JSON (no direct Polymarket calls).

## Local development

Uses [uv](https://docs.astral.sh/uv/).

```bash
# Fetch data, merge into data/series.json, rebuild docs/data/history.json
uv run python -m src.update

# Serve the site locally
uv run python -m http.server 8421 --directory docs
# → http://localhost:8421
```

## Layout

```
src/
  polymarket.py   # Gamma + CLOB API client
  entropy.py      # prob matrix, residual "Other" rule, entropy math
  update.py       # CI entrypoint: fetch → merge → write the data files
data/
  series.json     # raw per-candidate price store (source of truth, not published)
docs/             # GitHub Pages site (index.html, app.js, style.css)
  data/history.json     # entropy + context series, loaded on page load
  data/candidates.json  # per-candidate probabilities, loaded lazily by the candidate views
test_update.py    # self-check for the derived payload: uv run python test_update.py
```

Data source: [Polymarket](https://polymarket.com/event/next-french-presidential-election).
