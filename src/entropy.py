"""Entropy of the Polymarket candidate distribution.

Pipeline:

1. ``build_matrix`` aligns the per-candidate Yes-price series (sampled at
   irregular timestamps) onto a common time grid, forward-filling each
   candidate's last known price *after* its market's first data point and
   leaving ``None`` before it existed.
2. ``to_distribution`` turns one row of Yes-prices into a proper probability
   distribution, applying the residual "Other" rule.
3. ``entropy_*`` / ``effective_n`` compute the four display modes.

The four modes are monotonic transforms of the same quantity (entropy in nats):

    H_bits = H_nats / ln 2
    H_dits = H_nats / ln 10
    N_eff  = exp(H_nats) = 2^H_bits = 10^H_dits   (effective number of candidates)
"""

from __future__ import annotations

import math


def build_matrix(
    series_by_candidate: dict[str, list[tuple[int, float]]],
) -> tuple[list[str], list[int], dict[str, list[float | None]]]:
    """Align irregular per-candidate series onto a common timestamp grid.

    Parameters
    ----------
    series_by_candidate:
        ``{candidate_name: [(unix_seconds, price), ...]}`` (each sorted by time).

    Returns
    -------
    (candidates, grid, probs)
        ``candidates`` — sorted candidate names.
        ``grid``       — sorted unique union of all timestamps.
        ``probs``      — ``{name: [price | None for each grid point]}``; ``None``
                         before the candidate's first observation.
    """
    candidates = sorted(series_by_candidate)
    grid = sorted({t for series in series_by_candidate.values() for t, _ in series})

    probs: dict[str, list[float | None]] = {}
    for name in candidates:
        series = series_by_candidate[name]
        first_t = series[0][0] if series else None
        # Map for O(1) lookup of exact observations.
        by_t = dict(series)
        row: list[float | None] = []
        last: float | None = None
        for t in grid:
            if first_t is None or t < first_t:
                row.append(None)
                continue
            if t in by_t:
                last = by_t[t]
            row.append(last)
        probs[name] = row
    return candidates, grid, probs


def to_distribution(yes_prices: list[float]) -> list[float]:
    """Convert one row of candidate Yes-prices into a probability distribution.

    Applies the residual rule:

    * ``S = sum(yes_prices)`` over candidates present at this timestamp.
    * if ``S < 1``: append an "Other" atom of mass ``1 - S`` (distribution sums
      to 1 already).
    * if ``S >= 1``: renormalize the candidates by ``S`` (Other = 0), correcting
      the over-round caused by bid/ask spreads.

    The returned list contains the candidate probabilities followed by the Other
    atom (only when positive). Probabilities are clamped to be non-negative.
    """
    clean = [max(0.0, p) for p in yes_prices]
    s = sum(clean)
    if s <= 0:
        return []
    if s < 1.0:
        return clean + [1.0 - s]
    return [p / s for p in clean]


def entropy_nats(dist: list[float]) -> float:
    """Shannon entropy in nats (natural log), with 0*log0 = 0."""
    return -sum(p * math.log(p) for p in dist if p > 0.0)


def entropy_bits(dist: list[float]) -> float:
    return entropy_nats(dist) / math.log(2)


def entropy_dits(dist: list[float]) -> float:
    return entropy_nats(dist) / math.log(10)


def effective_n(dist: list[float]) -> float:
    """Effective number of candidates = exp(entropy in nats)."""
    return math.exp(entropy_nats(dist))


def entropy_series(
    candidates: list[str],
    grid: list[int],
    probs: dict[str, list[float | None]],
) -> dict[str, list[float | None]]:
    """Compute all four entropy modes per grid point from the prob matrix.

    Returns ``{"nats": [...], "bits": [...], "dits": [...], "effective_n": [...]}``
    with ``None`` where no candidate had data yet.
    """
    out = {"nats": [], "bits": [], "dits": [], "effective_n": []}
    for i in range(len(grid)):
        row = [probs[name][i] for name in candidates if probs[name][i] is not None]
        if not row:
            for key in out:
                out[key].append(None)
            continue
        dist = to_distribution(row)
        h = entropy_nats(dist)
        out["nats"].append(h)
        out["bits"].append(h / math.log(2))
        out["dits"].append(h / math.log(10))
        out["effective_n"].append(math.exp(h))
    return out
