"""Fetch latest Polymarket data, merge into the cache, and emit the site JSON.

Run with:  uv run python -m src.update

Maintains two files under ``docs/data/``:

* ``series.json``  — the raw per-candidate Yes-price history (source of truth).
  Each run merges freshly fetched points into it (union by timestamp), so
  fine-grained hourly points are preserved permanently even after they fall
  outside Polymarket's ~30-day hourly window.
* ``history.json`` — small derived series the website loads: the common time
  grid plus entropy (in nats), candidate count, and raw sum of probabilities.
  The four display modes are transforms of the nats series, computed in the
  browser.
* ``candidates.json`` — the per-candidate *normalized* probabilities (after the
  residual "Other" rule), downsampled, for the site's candidate views. Loaded
  lazily by the browser, so the entropy view stays cheap.
"""

from __future__ import annotations

import datetime as dt
import json
import os

from . import entropy, polymarket

ROOT = os.path.join(os.path.dirname(__file__), "..")
# Raw per-candidate price store (source of truth) lives outside docs/ so it is
# not published by GitHub Pages; only the small derived history.json is served.
SERIES_PATH = os.path.join(ROOT, "data", "series.json")
HISTORY_PATH = os.path.join(ROOT, "docs", "data", "history.json")
CANDIDATES_PATH = os.path.join(ROOT, "docs", "data", "candidates.json")

# The site only plots from 2026-01-01; anything older is dropped from the
# per-candidate payload (history.json keeps it, it is cheap there).
SITE_START = int(dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc).timestamp())
# Full resolution is kept for the recent window; older points are thinned to one
# per UTC day. Keeps candidates.json ~5x smaller than the raw grid.
FULL_RES_DAYS = 60


def _load_series() -> dict[str, list[tuple[int, float]]]:
    if not os.path.exists(SERIES_PATH):
        return {}
    with open(SERIES_PATH) as f:
        raw = json.load(f)
    return {name: [(int(t), float(p)) for t, p in pts] for name, pts in raw.items()}


def _merge(
    existing: dict[str, list[tuple[int, float]]],
    fresh: dict[str, list[tuple[int, float]]],
) -> dict[str, list[tuple[int, float]]]:
    """Union by timestamp per candidate, keeping existing values on collision."""
    merged: dict[str, list[tuple[int, float]]] = {}
    for name in set(existing) | set(fresh):
        by_t: dict[int, float] = {}
        for t, p in fresh.get(name, []):
            by_t[t] = p
        for t, p in existing.get(name, []):  # existing wins on collision
            by_t[t] = p
        merged[name] = sorted(by_t.items())
    return merged


def _save_series(series: dict[str, list[tuple[int, float]]]) -> None:
    payload = {name: [[t, p] for t, p in pts] for name, pts in series.items()}
    with open(SERIES_PATH, "w") as f:
        json.dump(payload, f, separators=(",", ":"))


def _build_history(series: dict[str, list[tuple[int, float]]]) -> dict:
    names, grid, probs = entropy.build_matrix(series)
    modes = entropy.entropy_series(names, grid, probs)
    n_candidates = [
        sum(1 for name in names if probs[name][i] is not None)
        for i in range(len(grid))
    ]
    sum_probs: list[float | None] = []
    for i in range(len(grid)):
        vals = [probs[name][i] for name in names if probs[name][i] is not None]
        sum_probs.append(round(sum(vals), 6) if vals else None)
    nats = [round(v, 6) if v is not None else None for v in modes["nats"]]

    return {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "method": {
            "prob": "yes_token_price",
            "residual": "synthesize_other_if_sum_lt_1_else_renormalize",
            "fidelities_min": [1440, 60],
        },
        "n_total_candidates": len(names),
        "grid": grid,
        "entropy_nats": nats,
        "n_candidates": n_candidates,
        "sum_probs": sum_probs,
    }


def _keep_indices(grid: list[int]) -> list[int]:
    """Indices of ``grid`` to publish: hourly recently, daily before.

    The raw grid is the union of every candidate's timestamps, so it holds
    several near-duplicate rows per hour (each market is sampled at its own
    offset). Snapping to one row per bucket costs no visible detail and keeps
    the published file — rewritten by CI every hour — small.
    """
    if not grid:
        return []
    cutoff = grid[-1] - FULL_RES_DAYS * 86400
    last_in_bucket: dict[tuple[int, int], int] = {}
    for i, t in enumerate(grid):
        if t < SITE_START:
            continue
        bucket = 3600 if t >= cutoff else 86400
        last_in_bucket[(bucket, t // bucket)] = i
    return sorted(last_in_bucket.values())


def _build_candidates(series: dict[str, list[tuple[int, float]]]) -> dict:
    """Per-candidate normalized probabilities on the (downsampled) grid.

    Unlike ``series.json`` (raw Yes-prices), these are the probabilities the
    entropy is actually computed from: renormalized when the prices over-round,
    with the synthetic ``Other`` atom carrying the residual mass. Each column
    therefore sums to 1, which is what the stacked/snapshot views need.
    """
    names, grid, probs = entropy.build_matrix(series)
    keep = _keep_indices(grid)

    out: dict[str, list[float | None]] = {name: [] for name in names}
    out["Other"] = []
    for i in keep:
        present = [name for name in names if probs[name][i] is not None]
        dist = entropy.to_distribution([probs[name][i] for name in present])
        # to_distribution returns the present candidates in order, plus a
        # trailing Other atom only when the prices under-round (S < 1).
        by_name = dict(zip(present, dist))
        for name in names:
            p = by_name.get(name)
            out[name].append(round(p, 5) if p is not None else None)
        out["Other"].append(round(dist[len(present)], 5) if len(dist) > len(present) else 0.0)

    return {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "grid": [grid[i] for i in keep],
        "candidates": out,
    }


def _save_candidates(payload: dict) -> None:
    with open(CANDIDATES_PATH, "w") as f:
        json.dump(payload, f, separators=(",", ":"))


def _save_history(history: dict) -> None:
    with open(HISTORY_PATH, "w") as f:
        json.dump(history, f, separators=(",", ":"))


def main() -> None:
    os.makedirs(os.path.dirname(SERIES_PATH), exist_ok=True)
    os.makedirs(os.path.dirname(HISTORY_PATH), exist_ok=True)

    print("Fetching candidate list...")
    candidates = polymarket.get_candidates()
    print(f"  {len(candidates)} live candidates")

    print("Fetching price history (daily + hourly)...")
    fresh = polymarket.fetch_all_histories(candidates)
    print(f"  fetched {len(fresh)} candidate series")

    existing = _load_series()
    merged = _merge(existing, fresh)
    _save_series(merged)
    total_points = sum(len(v) for v in merged.values())
    print(f"  merged store: {len(merged)} candidates, {total_points} points")

    history = _build_history(merged)
    _save_history(history)
    print(f"  wrote {HISTORY_PATH}  ({len(history['grid'])} grid points)")

    candidates_payload = _build_candidates(merged)
    _save_candidates(candidates_payload)
    print(
        f"  wrote {CANDIDATES_PATH}  "
        f"({len(candidates_payload['grid'])} grid points, "
        f"{len(candidates_payload['candidates'])} series)"
    )


if __name__ == "__main__":
    main()
