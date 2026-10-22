#!/bin/sh
# Starts or updates hive in this directory (/opt/hive). Run it after editing .env; CD runs it too.
# HIVE_IMAGE in the environment (or .env) picks the image; COMPOSE_FILE in .env picks the layout.
set -eu
cd "$(dirname "$0")"
env_value() { sed -n "s/^$1=//p" .env | tail -n 1; }

domain=$(env_value DOMAIN)
[ -n "$domain" ] || { echo "set DOMAIN in .env" >&2; exit 1; }
mkdir -p secrets

case "$(env_value COMPOSE_FILE)" in
  *docker-compose.edge.yml*) edge=/opt/edge ;;
  *) edge="" ;;
esac

[ -n "$edge" ] && { docker network inspect edge >/dev/null 2>&1 || docker network create edge >/dev/null; }
case "$(env_value COMPOSE_FILE)" in
  *docker-compose.build.yml*) docker compose up -d --build --remove-orphans ;;
  *)
    # A failed pull (e.g. a private package without docker login) falls back to the local image.
    docker compose pull --quiet hive || echo "pull failed; starting the image already on this machine" >&2
    docker compose up -d --remove-orphans ;;
esac

if [ -n "$edge" ]; then
  mkdir -p "$edge/sites"
  sed "s|__DOMAIN__|$domain|g" site.caddy > "$edge/sites/hive.caddy"
  "$edge/up.sh"
fi
echo "hive: https://$domain"
