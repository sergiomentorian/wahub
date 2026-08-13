#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ "$(id -u)" -eq 0 ]] || { echo "Execute como root." >&2; exit 2; }

install -m 0755 "$script_dir/update-waha.sh" /usr/local/sbin/mentorian-waha-auto-update
install -m 0644 "$script_dir/mentorian-waha-auto-update.service" /etc/systemd/system/
install -m 0644 "$script_dir/mentorian-waha-auto-update.timer" /etc/systemd/system/

if [[ ! -f /etc/mentorian-waha-updater.env ]]; then
  umask 077
  printf 'WAHA_BACKUP_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" > /etc/mentorian-waha-updater.env
fi
chmod 0600 /etc/mentorian-waha-updater.env
systemctl daemon-reload
systemctl enable --now mentorian-waha-auto-update.timer
echo "Atualizador WAHA instalado. Execute systemctl start mentorian-waha-auto-update.service para a primeira promoção."
