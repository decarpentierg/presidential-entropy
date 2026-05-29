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


if __name__ == "__main__":
    main()
