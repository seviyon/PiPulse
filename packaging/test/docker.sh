#!/bin/sh
# docker.sh IMAGE — start IMAGE and require health, config and the unavailable firmware plugins.
set -eu
image=$1
cid=$(docker run -d -e PIPULSE_PORT=18890 -p 18890:18890 "$image")
trap 'docker rm -f "$cid" >/dev/null' EXIT
for _ in $(seq 1 90); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$cid")" = healthy ] && break
  sleep 1
done
[ "$(docker inspect -f '{{.State.Health.Status}}' "$cid")" = healthy ] || { docker logs "$cid"; echo 'not ok - healthy'; exit 1; }
echo 'ok - healthy'
curl -fs http://127.0.0.1:18890/api/config | grep -q '"id":"cpu_voltage"[^}]*"unavailable":"Not available in Docker"' && echo 'ok - firmware plugins unavailable' || { echo 'not ok - firmware plugins unavailable'; exit 1; }
