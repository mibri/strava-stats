"""Live sync from the Strava API — writes data/ in the same layout as the bulk export.

The bulk export can only be requested about once a week; this pulls anything newer
straight from the API so `python -m pipeline.build` always has fresh data:

  - appends rows to data/activities.csv (matching its exact 103-column header,
    including the duplicate column names the export uses), and
  - writes GPX tracks (with heart-rate extensions) to data/activities/<id>.gpx.

One-time setup (~5 minutes, free for personal use):
  1. Create an API application at https://www.strava.com/settings/api
     - Authorization Callback Domain: localhost
     - note the Client ID and Client Secret.
  2. Run:  .venv/bin/python -m pipeline.strava_api --auth
     It asks for the ID/secret, opens the Strava consent page in your browser,
     catches the redirect on a local port, and saves tokens to
     data/strava_config.json (gitignored along with the rest of data/).

Then whenever you want fresh data:
       .venv/bin/python -m pipeline.strava_api            # sync new activities
       .venv/bin/python -m pipeline.strava_api --build    # sync, then rebuild data/clean

Notes on fidelity vs the export: the API has no weather data and no grade-adjusted
pace, so those columns stay blank for synced rows (the dashboard tolerates both).
Everything else — HR, cadence/steps, elevation, calories, relative effort,
descriptions — matches the export.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import ssl
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CONFIG_PATH = DATA / "strava_config.json"

API = "https://www.strava.com/api/v3"
AUTH_URL = "https://www.strava.com/oauth/authorize"
TOKEN_URL = "https://www.strava.com/oauth/token"
CALLBACK_PORT = 8723

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


# ---------------------------------------------------------------- http + auth

def _ssl_context() -> ssl.SSLContext:
    """python.org macOS builds ship without CA certs wired up; prefer certifi."""
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


_SSL_CTX = _ssl_context()


def _http(url: str, params: dict | None = None, data: dict | None = None,
          token: str | None = None):
    """GET (or form-POST when `data` is given) returning parsed JSON."""
    if params:
        url += "?" + urllib.parse.urlencode(params)
    body = urllib.parse.urlencode(data).encode() if data else None
    req = urllib.request.Request(url, data=body)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=60, context=_SSL_CTX) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:500]
        raise RuntimeError(f"Strava API {e.code} on {url.split('?')[0]}: {detail}") from e


def _load_config() -> dict:
    cfg = {}
    if CONFIG_PATH.exists():
        cfg = json.loads(CONFIG_PATH.read_text())
    # Environment variables override the file (handy for CI or ad-hoc use).
    for k, env in [("client_id", "STRAVA_CLIENT_ID"),
                   ("client_secret", "STRAVA_CLIENT_SECRET"),
                   ("refresh_token", "STRAVA_REFRESH_TOKEN")]:
        if os.environ.get(env):
            cfg[k] = os.environ[env]
    return cfg


def _save_config(cfg: dict) -> None:
    DATA.mkdir(exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2) + "\n")


def _access_token(cfg: dict) -> str:
    tok = _http(TOKEN_URL, data={
        "client_id": cfg["client_id"],
        "client_secret": cfg["client_secret"],
        "grant_type": "refresh_token",
        "refresh_token": cfg["refresh_token"],
    })
    # Strava rotates refresh tokens; persist the newest one.
    if tok.get("refresh_token") and tok["refresh_token"] != cfg.get("refresh_token"):
        cfg["refresh_token"] = tok["refresh_token"]
        _save_config(cfg)
    return tok["access_token"]


class _CodeCatcher(BaseHTTPRequestHandler):
    code: str | None = None
    error: str | None = None

    def do_GET(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/favicon.ico":
            self.send_response(404)
            self.end_headers()
            return
        qs = urllib.parse.parse_qs(parsed.query)
        _CodeCatcher.code = (qs.get("code") or [None])[0]
        _CodeCatcher.error = (qs.get("error") or [None])[0]
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        msg = "Authorized — you can close this tab." if _CodeCatcher.code else \
              f"Authorization failed ({_CodeCatcher.error or 'no code'}) — check the terminal."
        self.wfile.write(f"<h2>{msg}</h2>".encode())

    def log_message(self, *args):  # silence request logging
        pass


def authorize() -> None:
    """One-time OAuth dance; saves client creds + refresh token to data/."""
    cfg = _load_config()
    if cfg.get("client_id"):
        print(f"Using saved Client ID ({cfg['client_id']}); delete "
              f"{CONFIG_PATH.relative_to(ROOT)} to start over.")
    else:
        cfg["client_id"] = input("Strava Client ID: ").strip()
    if not cfg.get("client_secret"):
        cfg["client_secret"] = input("Strava Client Secret: ").strip()
    _save_config(cfg)  # persist immediately so a failed exchange doesn't lose them

    redirect = f"http://localhost:{CALLBACK_PORT}/"
    url = AUTH_URL + "?" + urllib.parse.urlencode({
        "client_id": cfg["client_id"],
        "redirect_uri": redirect,
        "response_type": "code",
        "approval_prompt": "auto",
        "scope": "activity:read_all",
    })
    print("\nOpening Strava consent page… approve access, then come back here.")
    print(f"(If the browser doesn't open, visit:\n  {url}\n)")
    webbrowser.open(url)

    try:
        server = HTTPServer(("localhost", CALLBACK_PORT), _CodeCatcher)
    except OSError as e:
        raise SystemExit(f"Could not listen on localhost:{CALLBACK_PORT} ({e}). "
                         "Close whatever is using that port and rerun --auth.")
    server.timeout = 300
    while _CodeCatcher.code is None and _CodeCatcher.error is None:
        server.handle_request()
    server.server_close()
    if not _CodeCatcher.code:
        raise SystemExit(f"Strava returned error '{_CodeCatcher.error}' — "
                         "you may have clicked Cancel on the consent page. Rerun --auth.")

    try:
        tok = _http(TOKEN_URL, data={
            "client_id": cfg["client_id"],
            "client_secret": cfg["client_secret"],
            "grant_type": "authorization_code",
            "code": _CodeCatcher.code,
        })
    except RuntimeError as e:
        raise SystemExit(
            f"Token exchange failed: {e}\n\n"
            "Almost always this means the Client ID and Client Secret don't match "
            "the app that showed the consent page. Double-check both at "
            "https://www.strava.com/settings/api (Client Secret is the long hex "
            "string — click 'show'), then rerun --auth.")
    if "refresh_token" not in tok:
        raise SystemExit(f"Unexpected token response (no refresh_token): {tok}")
    cfg["refresh_token"] = tok["refresh_token"]
    _save_config(cfg)
    athlete = tok.get("athlete") or {}
    print(f"\nAuthorized as {athlete.get('firstname', '?')} {athlete.get('lastname', '')}"
          f" — tokens saved to {CONFIG_PATH.relative_to(ROOT)}.")
    print("Run `.venv/bin/python -m pipeline.strava_api --build` to sync.")


# ------------------------------------------------------------- export format

def _fmt_activity_date(dt: datetime) -> str:
    """Match the export's UTC style exactly: 'Jul 8, 2026, 11:20:13 PM'."""
    h = dt.hour % 12 or 12
    ampm = "AM" if dt.hour < 12 else "PM"
    return f"{MONTHS[dt.month - 1]} {dt.day}, {dt.year}, {h}:{dt.minute:02d}:{dt.second:02d} {ampm}"


def _read_header(csv_path: Path) -> list[str]:
    with open(csv_path, newline="") as f:
        return next(csv.reader(f))


def _existing_state(csv_path: Path) -> tuple[set[str], datetime | None]:
    """IDs already on disk + the newest activity start (UTC)."""
    ids: set[str] = set()
    latest: datetime | None = None
    with open(csv_path, newline="") as f:
        reader = csv.reader(f)
        header = next(reader)
        i_id, i_date = header.index("Activity ID"), header.index("Activity Date")
        for row in reader:
            if not row or len(row) <= max(i_id, i_date):
                continue
            ids.add(row[i_id])
            try:
                d = datetime.strptime(row[i_date], "%b %d, %Y, %I:%M:%S %p")
                d = d.replace(tzinfo=timezone.utc)
                latest = d if latest is None or d > latest else latest
            except ValueError:
                pass
    return ids, latest


def _positional_row(header: list[str], values: dict) -> list[str]:
    """Build a row honoring duplicate column names.

    `values` keys are either 'Name' (first occurrence) or ('Name', n) for the
    n-th occurrence (0-based) — the export legitimately repeats e.g. 'Distance'.
    """
    seen: dict[str, int] = {}
    row = []
    for col in header:
        n = seen.get(col, 0)
        seen[col] = n + 1
        v = values.get((col, n), values.get(col, "") if n == 0 else "")
        row.append("" if v is None else str(v))
    return row


def _elev_gain_loss(alt: list) -> tuple[float, float]:
    """Gain/loss in meters from a (noisy) altitude stream: light smoothing + sum."""
    pts = [a for a in alt if a is not None]
    if len(pts) < 3:
        return 0.0, 0.0
    k = 5
    smoothed = [sum(pts[max(0, i - k // 2): i + k // 2 + 1]) /
                len(pts[max(0, i - k // 2): i + k // 2 + 1]) for i in range(len(pts))]
    gain = loss = 0.0
    for a, b in zip(smoothed, smoothed[1:]):
        d = b - a
        if d > 0:
            gain += d
        else:
            loss -= d
    return gain, loss


def _write_gpx(path: Path, name: str, start: datetime, streams: dict) -> bool:
    """Synthesize an export-style GPX (with HR extension) from API streams."""
    latlng = (streams.get("latlng") or {}).get("data")
    if not latlng:
        return False  # no GPS (treadmill etc.) — the pipeline handles trackless runs
    t = (streams.get("time") or {}).get("data") or list(range(len(latlng)))
    alt = (streams.get("altitude") or {}).get("data") or [None] * len(latlng)
    hr = (streams.get("heartrate") or {}).get("data") or [None] * len(latlng)

    def esc(s: str) -> str:
        return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))

    out = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx creator="strava_api sync" version="1.1"',
        ' xmlns="http://www.topografix.com/GPX/1/1"',
        ' xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">',
        f' <metadata><time>{start.strftime("%Y-%m-%dT%H:%M:%SZ")}</time></metadata>',
        f' <trk><name>{esc(name)}</name><type>running</type><trkseg>',
    ]
    for i, ll in enumerate(latlng):
        ts = (start + timedelta(seconds=t[i])).strftime("%Y-%m-%dT%H:%M:%SZ")
        out.append(f'  <trkpt lat="{ll[0]}" lon="{ll[1]}">')
        if i < len(alt) and alt[i] is not None:
            out.append(f'   <ele>{alt[i]}</ele>')
        out.append(f'   <time>{ts}</time>')
        if i < len(hr) and hr[i] is not None:
            out.append('   <extensions><gpxtpx:TrackPointExtension>'
                       f'<gpxtpx:hr>{int(hr[i])}</gpxtpx:hr>'
                       '</gpxtpx:TrackPointExtension></extensions>')
        out.append('  </trkpt>')
    out += [' </trkseg></trk>', '</gpx>', '']
    path.write_text("\n".join(out))
    return True


# --------------------------------------------------------------------- sync

def _api_fetcher(token: str):
    def fetch(path: str, params: dict | None = None):
        return _http(f"{API}{path}", params=params, token=token)
    return fetch


def fetch_new_activities(data_dir: Path = DATA, fetch=None, overlap_days: int = 7) -> int:
    """Download activities newer than what's on disk, in export layout.

    `fetch(path, params)` is injectable for tests. Returns # of activities added.
    """
    csv_path = data_dir / "activities.csv"
    tracks_dir = data_dir / "activities"
    if not csv_path.exists():
        raise SystemExit(f"{csv_path} not found — unpack a bulk export first; "
                         "the API sync only appends to it.")
    if fetch is None:
        cfg = _load_config()
        if not all(cfg.get(k) for k in ("client_id", "client_secret", "refresh_token")):
            raise SystemExit("Strava API not configured — run "
                             "`.venv/bin/python -m pipeline.strava_api --auth` first.")
        fetch = _api_fetcher(_access_token(cfg))

    header = _read_header(csv_path)
    existing_ids, latest = _existing_state(csv_path)
    after = int(((latest or datetime(2000, 1, 1, tzinfo=timezone.utc))
                 - timedelta(days=overlap_days)).timestamp())

    summaries, page = [], 1
    while True:
        batch = fetch("/athlete/activities",
                      {"after": after, "page": page, "per_page": 100})
        if not batch:
            break
        summaries += [a for a in batch if str(a["id"]) not in existing_ids]
        if len(batch) < 100:
            break
        page += 1
    if not summaries:
        print("Already up to date — no new activities.")
        return 0

    tracks_dir.mkdir(exist_ok=True)
    new_rows = []
    for s in sorted(summaries, key=lambda a: a["start_date"]):
        aid = str(s["id"])
        start = datetime.strptime(s["start_date"], "%Y-%m-%dT%H:%M:%S%z")
        sport = s.get("sport_type") or s.get("type") or "Workout"
        # The export uses spaced names ("Trail Run"); the API camel-cases them.
        atype = "".join(c if not c.isupper() or i == 0 else f" {c}"
                        for i, c in enumerate(sport))
        is_run = "Run" in atype

        detail, streams, filename = {}, {}, ""
        if is_run:
            detail = fetch(f"/activities/{aid}", {"include_all_efforts": "false"})
            streams = fetch(f"/activities/{aid}/streams",
                            {"keys": "time,latlng,altitude,heartrate,cadence,distance",
                             "key_by_type": "true"})
            gpx_path = tracks_dir / f"{aid}.gpx"
            if _write_gpx(gpx_path, s.get("name", "Run"), start, streams):
                filename = f"activities/{aid}.gpx"

        gain = s.get("total_elevation_gain") or 0.0
        _, loss = _elev_gain_loss((streams.get("altitude") or {}).get("data") or [])
        moving, elapsed = s.get("moving_time") or 0, s.get("elapsed_time") or 0
        dist_m = s.get("distance") or 0.0
        avg_cad = detail.get("average_cadence") or s.get("average_cadence")
        steps = round(avg_cad * 2 * moving / 60) if avg_cad and moving else ""
        effort = detail.get("suffer_score") or s.get("suffer_score") or ""

        v = {
            "Activity ID": aid,
            "Activity Date": _fmt_activity_date(start.astimezone(timezone.utc)),
            "Activity Name": s.get("name", ""),
            "Activity Type": atype,
            "Activity Description": detail.get("description") or "",
            ("Elapsed Time", 0): elapsed, ("Elapsed Time", 1): elapsed,
            ("Distance", 0): round(dist_m / 1000, 2), ("Distance", 1): dist_m,
            "Moving Time": moving,
            ("Max Heart Rate", 0): s.get("max_heartrate") or "",
            ("Max Heart Rate", 1): s.get("max_heartrate") or "",
            "Average Heart Rate": s.get("average_heartrate") or "",
            ("Relative Effort", 0): effort, ("Relative Effort", 1): effort,
            "Max Speed": s.get("max_speed") or "",
            "Average Speed": round(dist_m / moving, 3) if moving else "",
            "Elevation Gain": round(gain, 1),
            "Elevation Loss": round(loss, 1),
            "Elevation Low": s.get("elev_low", ""),
            "Elevation High": s.get("elev_high", ""),
            "Average Cadence": avg_cad or "",
            "Max Cadence": detail.get("max_cadence") or "",
            "Calories": detail.get("calories") or "",
            "Total Steps": steps,
            "Filename": filename,
            "From Upload": 1,
            "Commute": 0,
            "Media": "",
        }
        new_rows.append(_positional_row(header, v))
        print(f"  + {atype:12s} {s.get('name', '')[:40]:40s} "
              f"{dist_m / 1609.34:5.1f} mi  {start.date()}  "
              f"{'gpx' if filename else 'no track'}")

    # Append, making sure we start on a fresh line.
    with open(csv_path, "rb+") as f:
        f.seek(0, 2)
        if f.tell():
            f.seek(-1, 2)
            if f.read(1) != b"\n":
                f.write(b"\n")
    with open(csv_path, "a", newline="") as f:
        csv.writer(f).writerows(new_rows)

    print(f"Wrote {len(new_rows)} new activities "
          f"({sum(1 for r in new_rows if 'gpx' in ''.join(r))} with tracks).")
    return len(new_rows)


def main() -> None:
    ap = argparse.ArgumentParser(description="Sync new activities from the Strava API.")
    ap.add_argument("--auth", action="store_true", help="run the one-time OAuth setup")
    ap.add_argument("--build", action="store_true", help="run pipeline.build after syncing")
    ap.add_argument("--overlap-days", type=int, default=7,
                    help="re-check this many days before the newest local activity")
    args = ap.parse_args()

    if args.auth:
        authorize()
        return
    n = fetch_new_activities(overlap_days=args.overlap_days)
    if args.build and n:
        print("\nRebuilding derived data…")
        subprocess.run([sys.executable, "-m", "pipeline.build"], cwd=ROOT, check=True)


if __name__ == "__main__":
    main()
