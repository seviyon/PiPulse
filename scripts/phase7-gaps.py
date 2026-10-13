#!/usr/bin/env python3
"""Phase 7 gap check: list holes in every PiPulse metric since the soak week started.

  python3 -I scripts/phase7-gaps.py [host] [start-iso]
  python3 -I scripts/phase7-gaps.py --base https://io.local:8889 --start 2026-10-09T12:10:00+00:00

Exit 0: every metric has 1-minute buckets with no hole longer than 3 minutes (and no
missing lead or tail). Exit 1: at least one metric has holes. Exit 2: PiPulse can't be
read (the message says why). The certificate is verified against the system's trust
store; export the PiPulse CA (`sudo pipulse tls export-ca`) and trust it on this machine.
"""
import argparse
import http.client
import json
import ssl
import sys
import time
from datetime import datetime, timezone
from urllib.parse import urlsplit

TOLERANCE_MS = 3 * 60_000  # a 1m bucket lags ~1-2 min behind now, so tail tolerance is 3 min

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("host", nargs="?", default="io.local")
parser.add_argument("start", nargs="?", default="2026-10-09T12:10:00+00:00")
parser.add_argument("--base", help="the server's base URL (default https://HOST:8889)")
parser.add_argument("--start", dest="start_opt", help="same as the positional start")
args = parser.parse_args()
start = args.start_opt or args.start
base = (args.base or f"https://{args.host}:8889").rstrip("/")
target = urlsplit(base)
if target.scheme not in ("http", "https") or not target.hostname:
    print(f"--base must be an http:// or https:// URL, not {base!r}", file=sys.stderr)
    sys.exit(2)
context = ssl.create_default_context()


def get(path):
    # http.client speaks only HTTP(S): no file: or custom scheme can be opened by mistake.
    if target.scheme == "https":
        connection = http.client.HTTPSConnection(target.hostname, target.port, timeout=20, context=context)
    else:
        connection = http.client.HTTPConnection(target.hostname, target.port, timeout=20)
    try:
        connection.request("GET", target.path.rstrip("/") + path)
        response = connection.getresponse()
        if response.status != 200:
            raise OSError(f"HTTP {response.status} for {path}")
        return json.load(response)
    finally:
        connection.close()


def stamp(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%m-%d %H:%M")


try:
    config = get("/api/config")
    now = int(time.time() * 1000)
    t0 = int(datetime.fromisoformat(start).timestamp() * 1000)
    print(f"PiPulse {config['version']} at {base}, window {start} .. now ({(now - t0) / 86_400_000:.2f} days)")
    bad = 0
    for plugin in config["plugins"]:
        pid = plugin["id"]
        points = get(f"/api/metrics/{pid}/series?from={t0}&to={now}&resolution=1m")["points"]
        if not points:
            print(f"{pid:18} no points")
            bad += 1
            continue
        holes = [(a["ts"], b["ts"]) for a, b in zip(points, points[1:]) if b["ts"] - a["ts"] > TOLERANCE_MS]
        lead = points[0]["ts"] - t0
        tail = now - points[-1]["ts"]
        flag = "ok" if not holes and lead < TOLERANCE_MS and tail < TOLERANCE_MS else "GAPS"
        bad += flag != "ok"
        print(f"{pid:18} {len(points):6} buckets  {flag}")
        if lead >= TOLERANCE_MS:
            print(f"    no data for the first {lead / 60_000:.0f} min of the window")
        if tail >= TOLERANCE_MS:
            print(f"    no data for the last {tail / 60_000:.0f} min")
        for a, b in holes[:10]:
            print(f"    no data {stamp(a)} -> {stamp(b)} UTC ({(b - a) / 60_000:.0f} min)")
    sys.exit(1 if bad else 0)
except (http.client.HTTPException, ssl.SSLError, OSError, KeyError, ValueError) as error:
    print(f"can't read PiPulse at {base}: {error}", file=sys.stderr)
    sys.exit(2)
