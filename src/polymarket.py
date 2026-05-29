"""Polymarket API client for the French 2027 presidential election event.

Two public, no-auth APIs are used:

* Gamma  (``gamma-api.polymarket.com``) — event/market discovery + current prices.
* CLOB   (``clob.polymarket.com``)      — historical price time series per token.

The election is modelled by Polymarket as one *event* containing many binary
*markets* (one per candidate, "Will X win the 2027 French presidential
election?"). Each market has two outcome tokens; index 0 is the "Yes" token,
whose price is the implied probability that the candidate wins.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass

import requests

GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"

EVENT_SLUG = "next-french-presidential-election"

# Polite pause between CLOB history calls (rate limit is ~1000/10s; we are far
# below it, but stay courteous).
_HISTORY_PAUSE_S = 0.1


@dataclass(frozen=True)
class Candidate:
    """A live candidate market within the event."""

    name: str          # human-readable candidate name (e.g. "Jordan Bardella")
    market_id: str     # Gamma market id
    yes_token_id: str  # CLOB token id for the "Yes" outcome
    yes_price: float | None  # current Yes price from Gamma (implied probability)


def _get(url: str, params: dict | None = None, *, retries: int = 4) -> object:
    """GET with simple exponential backoff on transient failures."""
    last_exc: Exception | None = None
    for attempt in range(retries):
        try:
            resp = requests.get(url, params=params, timeout=30)
            resp.raise_for_status()
            return resp.json()
        except requests.RequestException as exc:  # noqa: PERF203 - retry loop
            last_exc = exc
            time.sleep(0.5 * (2**attempt))
    raise RuntimeError(f"GET {url} failed after {retries} attempts") from last_exc


def _parse_json_field(value: object) -> object:
    """Gamma returns some array fields as JSON-encoded strings; decode them."""
    if isinstance(value, str):
        return json.loads(value)
    return value


def get_candidates(slug: str = EVENT_SLUG) -> list[Candidate]:
    """Return the live named candidates for the election event.

    Filters to markets that are ``active`` and expose a parseable Yes price and
    Yes token id. Dormant placeholder markets ("Person X", the inactive
    "Another person" market, etc.) are skipped. Re-enumerated on every call so a
    changing candidate set is handled automatically.
    """
    events = _get(f"{GAMMA}/events", params={"slug": slug})
    if not events:
        raise RuntimeError(f"No event found for slug {slug!r}")
    event = events[0]

    candidates: list[Candidate] = []
    for market in event.get("markets", []):
        if not market.get("active", False):
            continue
        try:
            token_ids = _parse_json_field(market.get("clobTokenIds"))
            prices = _parse_json_field(market.get("outcomePrices"))
        except (json.JSONDecodeError, TypeError):
            continue
        if not token_ids or not prices:
            continue

        yes_token = str(token_ids[0])
        try:
            yes_price = float(prices[0])
        except (TypeError, ValueError):
            yes_price = None

        candidates.append(
            Candidate(
                name=_candidate_name(market),
                market_id=str(market.get("id")),
                yes_token_id=yes_token,
                yes_price=yes_price,
            )
        )
    return candidates


def _candidate_name(market: dict) -> str:
    """Extract a clean candidate name from a market's question."""
    # Prefer the explicit groupItemTitle if present (Polymarket sets this to the
    # candidate name for grouped election markets); fall back to parsing the
    # question text "Will <Name> win the 2027 French presidential election?".
    title = market.get("groupItemTitle")
    if title:
        return str(title).strip()
    question = str(market.get("question", "")).strip()
    prefix, suffix = "Will ", " win"
    if question.startswith(prefix) and suffix in question:
        return question[len(prefix) : question.index(suffix)].strip()
    return question or str(market.get("id"))


def prices_history(
    token_id: str, *, interval: str = "max", fidelity: int = 60
) -> list[tuple[int, float]]:
    """Fetch the historical price series for a token.

    Returns a list of ``(unix_seconds, price)`` sorted by time. ``fidelity`` is
    the bucket size in minutes (60 = hourly, 1440 = daily); ``interval=max``
    fetches the full available range (back to market creation).
    """
    data = _get(
        f"{CLOB}/prices-history",
        params={"market": token_id, "interval": interval, "fidelity": fidelity},
    )
    history = data.get("history", []) if isinstance(data, dict) else []
    series = [(int(pt["t"]), float(pt["p"])) for pt in history]
    series.sort(key=lambda tp: tp[0])
    time.sleep(_HISTORY_PAUSE_S)
    return series


def merged_history(
    token_id: str, *, fidelities: tuple[int, ...] = (1440, 60)
) -> list[tuple[int, float]]:
    """Fetch and merge several fidelities into one series for a token.

    Polymarket caps fine-grained history to a recent window: ``fidelity=60``
    (hourly) returns only ~30 days, while ``fidelity=1440`` (daily) reaches back
    to market creation. Fetching both and merging by timestamp yields the full
    span with fine resolution over the recent window. Later fidelities win on
    exact-timestamp collisions (rare).
    """
    by_t: dict[int, float] = {}
    for fid in fidelities:
        for t, p in prices_history(token_id, fidelity=fid):
            by_t[t] = p
    return sorted(by_t.items())


def fetch_all_histories(
    candidates: list[Candidate], *, fidelities: tuple[int, ...] = (1440, 60)
) -> dict[str, list[tuple[int, float]]]:
    """Fetch the merged Yes-token price history for every candidate.

    Keyed by candidate name. Candidates whose history fetch fails or is empty
    are omitted.
    """
    out: dict[str, list[tuple[int, float]]] = {}
    for cand in candidates:
        try:
            series = merged_history(cand.yes_token_id, fidelities=fidelities)
        except RuntimeError:
            continue
        if series:
            out[cand.name] = series
    return out
