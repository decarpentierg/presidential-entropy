"""Self-check for the derived per-candidate payload.

Run with:  uv run python test_update.py
"""

from __future__ import annotations

from src import update

DAY = 86400
NOW = update.SITE_START + 200 * DAY


def test_keep_indices_thins_old_points_only():
    old = update.SITE_START + 10 * DAY  # far outside the full-res window
    grid = [update.SITE_START - DAY]  # before the site start: dropped entirely
    grid += [old, old + 600, old + 3600]  # same UTC day: only the last survives
    grid += [NOW - 3600, NOW - 60, NOW]  # recent: 2 hourly buckets, last of each

    keep = update._keep_indices(grid)
    assert [grid[i] for i in keep] == [old + 3600, NOW - 60, NOW], keep


def test_candidates_columns_sum_to_one():
    series = {
        # under-round: prices sum to 0.6, the Other atom carries 0.4
        "A": [(NOW, 0.5)],
        "B": [(NOW, 0.1)],
        # C only exists later, and pushes the row into over-round territory
        "C": [(NOW + 3600, 0.9)],
    }
    payload = update._build_candidates(series)
    cands = payload["candidates"]

    assert cands["A"][0] == 0.5 and cands["B"][0] == 0.1
    assert cands["C"][0] is None  # no market yet at the first timestamp
    assert cands["Other"][0] == 0.4

    # second row: 0.5 + 0.1 + 0.9 = 1.5 -> renormalized, no Other mass
    assert abs(cands["C"][1] - 0.9 / 1.5) < 1e-4
    assert cands["Other"][1] == 0.0

    for i in range(len(payload["grid"])):
        total = sum(cands[n][i] or 0.0 for n in cands)
        assert abs(total - 1.0) < 1e-4, (i, total)


if __name__ == "__main__":
    test_keep_indices_thins_old_points_only()
    test_candidates_columns_sum_to_one()
    print("ok")
