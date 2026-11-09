"""Minimal Supabase REST client for the weekly training job (standard library only).

Input: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the environment (a GitHub Actions secret; never a
file, never printed). Output: rows from the service-role RPCs api.ml_export, api.ml_export_cards and
api.ml_v2_params, and api.ml_write_weights to publish a model.
Nothing here prints a row, a key or a URL; errors show the RPC name and the HTTP status only.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from datetime import datetime, timezone

TIMEOUT_S = 60
MAX_PAGES = 400                  # 400 pages x 5,000 rows = 2,000,000 rows: a hard stop for a runaway loop


class SupaError(RuntimeError):
    pass


class Supa:
    def __init__(self, url: str | None = None, key: str | None = None):
        self.url = (url or os.environ.get("SUPABASE_URL", "")).rstrip("/")
        self._key = key or os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
        if not self.url or not self._key:
            raise SupaError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")

    def __repr__(self) -> str:                    # never show the key
        return "Supa(<configured>)"

    def rpc(self, name: str, payload: dict):
        req = urllib.request.Request(
            f"{self.url}/rest/v1/rpc/{name}", data=json.dumps(payload).encode("utf-8"), method="POST",
            headers={"apikey": self._key, "Authorization": f"Bearer {self._key}", "Content-Type": "application/json",
                     "Content-Profile": "api", "Accept-Profile": "api"})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raise SupaError(f"rpc {name}: HTTP {e.code}") from None
        except urllib.error.URLError:
            raise SupaError(f"rpc {name}: network error") from None

    def export(self, what: str, since_iso: str) -> list[dict]:
        """Every row of api.ml_export(what, since), following the `next` key."""
        rows, nxt = [], None
        for _ in range(MAX_PAGES):
            r = self.rpc("ml_export", {"p_what": what, "p_since": since_iso, "p_next": nxt, "p_limit": 5000})
            rows += r.get("rows") or []
            nxt = r.get("next")
            if not nxt:
                return rows
        raise SupaError("ml_export: too many pages")

    def export_cards(self, since_iso: str) -> list[dict]:
        rows, nxt = [], None
        for _ in range(MAX_PAGES):
            r = self.rpc("ml_export_cards", {"p_since": since_iso, "p_next": nxt, "p_limit": 5000})
            rows += r.get("rows") or []
            nxt = r.get("next")
            if not nxt:
                return rows
        raise SupaError("ml_export_cards: too many pages")

    def params(self) -> dict:
        return self.rpc("ml_v2_params", {})

    def write_weights(self, model: dict, rows: list[dict]) -> dict:
        return self.rpc("ml_write_weights", {"p_model": model, "p_rows": rows})


def iso_to_hours(s: str) -> float:
    """ISO timestamp -> hours since the Unix epoch (the unit every v2 function uses)."""
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() / 3600.0


def hours_to_iso(h: float) -> str:
    return datetime.fromtimestamp(h * 3600.0, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
