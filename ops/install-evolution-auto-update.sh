#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ "$(id -u)" -eq 0 ]] || { echo "Execute como root." >&2; exit 2; }

install -m 0755 "$script_dir/update-evolution.sh" /usr/local/sbin/mentorian-evolution-auto-update
install -m 0644 "$script_dir/mentorian-evolution-auto-update.service" /etc/systemd/system/
install -m 0644 "$script_dir/mentorian-evolution-auto-update.timer" /etc/systemd/system/

if [[ ! -f /etc/mentorian-evolution-updater.env ]]; then
  umask 077
  printf 'EVOLUTION_BACKUP_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" > /etc/mentorian-evolution-updater.env
fi
chmod 0600 /etc/mentorian-evolution-updater.env
systemctl daemon-reload
systemctl enable --now mentorian-evolution-auto-update.timer
echo "Atualizador Evolution instalado. Execute systemctl start mentorian-evolution-auto-update.service para a primeira verificação."
