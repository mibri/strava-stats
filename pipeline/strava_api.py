"""Stretch-goal stub: pull new activities from the Strava API.

This is intentionally a thin, documented skeleton so the live-sync feature is easy
to bolt on later WITHOUT changing the rest of the pipeline. The contract:

    fetch_new_activities() should download any activities newer than what's already
    in data/activities/ and write them in the SAME layout the bulk export uses:
      - append rows to data/activities.csv (matching its columns), and
      - drop track files into data/activities/<id>.fit (or .gpx)

    Then `python -m pipeline.build` re-derives everything as usual.

Setup when you're ready (see https://developers.strava.com):
  1. Create an API application at https://www.strava.com/settings/api
     → note Client ID + Client Secret, set Authorization Callback Domain to localhost.
  2. Do the one-time OAuth dance to get a refresh token (scope: activity:read_all).
  3. Put credentials in environment variables (never commit them):
       STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_REFRESH_TOKEN
  4. Implement the TODOs below using the /oauth/token and
     /api/v3/athlete/activities + /activities/{id}/streams endpoints.
"""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"


def _creds() -> dict[str, str] | None:
    keys = ("STRAVA_CLIENT_ID", "STRAVA_CLIENT_SECRET", "STRAVA_REFRESH_TOKEN")
    vals = {k: os.environ.get(k) for k in keys}
    return vals if all(vals.values()) else None


def fetch_new_activities() -> int:
    """Download activities newer than the latest already on disk.

    Returns the number of new runs written. Not yet implemented — wire it up by
    following the setup notes above. Kept as a no-op so the pipeline stays runnable
    on the static export alone.
    """
    creds = _creds()
    if not creds:
        print("Strava API not configured — set STRAVA_CLIENT_ID / _SECRET / _REFRESH_TOKEN "
              "to enable live sync. Skipping.")
        return 0

    # TODO: refresh access token via POST https://www.strava.com/oauth/token
    # TODO: find newest activity id/date already in data/activities.csv
    # TODO: page GET /api/v3/athlete/activities?after=<epoch> filtering type == "Run"
    # TODO: for each, GET /activities/{id}/streams and save a track file + CSV row
    raise NotImplementedError(
        "Strava live sync is stubbed. Implement the TODOs in pipeline/strava_api.py "
        "to enable it, then run `python -m pipeline.build`."
    )


if __name__ == "__main__":
    fetch_new_activities()
