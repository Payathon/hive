#!/usr/bin/env bash
# One-time bootstrap for a fresh Ubuntu 22.04 / 24.04 server. Safe to run again.
# Usage (as the SSH user with sudo):  curl -fsSL <raw url>/deploy/setup.sh | bash   or   bash setup.sh
# Installs Docker Engine + the compose plugin, adds you to the docker group, creates /opt/hive,
# and adds 2 GB of swap on small machines. Ports 22/80/443 are opened in the cloud security group,
# not here (see deploy/README.md).
set -euo pipefail

SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"
USER_NAME="${SUDO_USER:-$(id -un)}"

. /etc/os-release
if [ "${ID:-}" != "ubuntu" ]; then
  echo "this script expects Ubuntu (found ${ID:-unknown})" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo "==> installing Docker Engine and the compose plugin"
  $SUDO apt-get update -y
  $SUDO apt-get install -y ca-certificates curl
  $SUDO install -m 0755 -d /etc/apt/keyrings
  $SUDO curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  $SUDO chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" |
    $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null
  $SUDO apt-get update -y
  $SUDO apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  echo "==> docker already installed: $(docker --version)"
fi
$SUDO systemctl enable --now docker

if [ "$USER_NAME" != "root" ] && ! id -nG "$USER_NAME" | grep -qw docker; then
  echo "==> adding $USER_NAME to the docker group (log out and back in for it to apply)"
  $SUDO usermod -aG docker "$USER_NAME"
fi

echo "==> /opt/hive"
$SUDO mkdir -p /opt/hive/secrets
$SUDO chown -R "$USER_NAME":"$USER_NAME" /opt/hive

# 2 vCPU / 2 GB machines: swap keeps image pulls and Postgres from hitting the OOM killer.
if [ "$(swapon --show --noheadings | wc -l)" -eq 0 ] && [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 3500000 ]; then
  echo "==> adding a 2 GB swapfile"
  $SUDO fallocate -l 2G /swapfile
  $SUDO chmod 600 /swapfile
  $SUDO mkswap /swapfile >/dev/null
  $SUDO swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | $SUDO tee -a /etc/fstab >/dev/null
fi

if command -v ufw >/dev/null 2>&1 && $SUDO ufw status | grep -q "Status: active"; then
  echo "==> ufw is active: allowing 22, 80, 443"
  $SUDO ufw allow 22/tcp && $SUDO ufw allow 80/tcp && $SUDO ufw allow 443/tcp && $SUDO ufw allow 443/udp
fi

cat <<MSG

Done. Next:
  1. Put docker-compose.yml, Caddyfile and .env (from .env.example) into /opt/hive
     (the deploy workflow copies the first two on every push to main).
  2. cd /opt/hive && docker compose pull && docker compose up -d
  3. curl https://<your domain>/healthz
Make sure the cloud security group allows inbound 22, 80 and 443 (80 is needed for the certificate).
MSG
