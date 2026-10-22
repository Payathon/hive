#!/bin/sh
# Starts the edge Caddy if it is not running and reloads its config. Called by each app's up.sh.
set -eu
cd "$(dirname "$0")"
mkdir -p sites
docker network inspect edge >/dev/null 2>&1 || docker network create edge >/dev/null
docker compose up -d --remove-orphans
# A fresh container reads the config itself; a running one needs the reload to see new site files.
for _ in 1 2 3 4 5; do
  docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile && exit 0
  sleep 2
done
echo "caddy reload failed; see: docker compose -f $(pwd)/docker-compose.yml logs caddy" >&2
exit 1
