#!/usr/bin/env bash
set -euo pipefail

exec 9>/run/lock/mentorian-waha-auto-update.lock
flock --nonblock 9 || { echo "Outra atualização WAHA já está em andamento."; exit 0; }

state_dir="${WAHA_UPDATE_STATE_DIR:-/var/lib/mentorian-waha-update}"
backup_dir="$state_dir/backups"
mkdir -p "$backup_dir"
chmod 0700 "$state_dir" "$backup_dir"
[[ -n "${WAHA_BACKUP_ENCRYPTION_KEY:-}" && ${#WAHA_BACKUP_ENCRYPTION_KEY} -ge 32 ]] || {
  echo "WAHA_BACKUP_ENCRYPTION_KEY ausente ou curta; atualização bloqueada." >&2
  exit 2
}

waha_id="$(docker ps -q --filter label=com.docker.compose.service=waha | head -n1)"
broker_id="$(docker ps -q --filter label=com.docker.compose.service=broker | head -n1)"
[[ -n "$waha_id" && -n "$broker_id" ]] || { echo "WAHA ou broker não está em execução." >&2; exit 2; }

workdir="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$waha_id")"
config_files="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' "$waha_id")"
project="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$waha_id")"
[[ -n "$workdir" && -n "$config_files" && -n "$project" ]] || { echo "Metadados Compose ausentes." >&2; exit 2; }
cd "$workdir"

compose=(docker compose -p "$project")
IFS=',' read -r -a compose_file_list <<< "$config_files"
for compose_file in "${compose_file_list[@]}"; do compose+=(-f "$compose_file"); done

release_json="$(curl --fail --silent --show-error https://api.github.com/repos/devlikeapro/waha/releases/latest)"
stable_version="$(python3 -c 'import json,sys,re; r=json.loads(sys.argv[1]); v=str(r.get("tag_name", "")).removeprefix("v"); assert not r.get("draft") and not r.get("prerelease") and re.fullmatch(r"[0-9]{4}\.[0-9]+\.[0-9]+", v); print(v)' "$release_json")"
current_version="$(docker exec "$broker_id" node -e 'const fs=require("fs");let v="";try{v=JSON.parse(fs.readFileSync("/config/provider-release-state.json","utf8")).providers.waha.installedVersion||""}catch{};process.stdout.write(v||process.env.WAHA_VERSION||"")')"
[[ "$current_version" =~ ^[0-9]{4}\.[0-9]+\.[0-9]+$ ]] || { echo "Versão WAHA instalada inválida." >&2; exit 2; }

write_release_state() {
  local version="$1" source="$2" updated_at="$3"
  docker exec -e RELEASE_VERSION="$version" -e RELEASE_SOURCE="$source" -e RELEASE_UPDATED_AT="$updated_at" "$broker_id" node -e '
    const fs=require("fs"), file="/config/provider-release-state.json", temp=`${file}.tmp`;
    let state={version:1,providers:{}}; try{state=JSON.parse(fs.readFileSync(file,"utf8"))}catch{}
    state.version=1; state.providers=state.providers&&typeof state.providers==="object"?state.providers:{};
    state.providers.waha={installedVersion:process.env.RELEASE_VERSION,releaseChannel:"stable",automaticUpdates:true,lastUpdatedAt:process.env.RELEASE_UPDATED_AT,lastUpdateSource:process.env.RELEASE_SOURCE};
    fs.writeFileSync(temp,JSON.stringify(state,null,2),{mode:0o600}); fs.renameSync(temp,file);'
}

if [[ "$current_version" = "$stable_version" ]]; then
  current_updated_at="$(docker exec "$broker_id" node -e 'const fs=require("fs");let d="";try{d=JSON.parse(fs.readFileSync("/config/provider-release-state.json","utf8")).providers.waha.lastUpdatedAt||""}catch{};process.stdout.write(d||process.env.WAHA_UPDATED_AT||new Date().toISOString())')"
  write_release_state "$current_version" release "$current_updated_at"
  echo "WAHA já está na versão estável $current_version; atualizador confirmado."
  exit 0
fi

candidate_image="ghcr.io/sergiomentorian/waha-noweb:${stable_version}-baileys-rc14"
docker pull "$candidate_image"
docker pull alpine:3.20
docker run --rm --entrypoint node "$candidate_image" -e '
  const p=require("/app/node_modules/@adiwajshing/baileys/package.json");
  if(p.version!=="7.0.0-rc14") process.exit(2);'

session_counts() {
  docker exec "$broker_id" node -e '
    fetch(`${process.env.WAHA_API_URL}/api/sessions?all=true`,{headers:{"X-Api-Key":process.env.WAHA_API_KEY}})
      .then(async r=>{if(!r.ok)throw Error(String(r.status));const b=await r.json();const a=Array.isArray(b)?b:(b.sessions||[]);console.log(JSON.stringify({registered:a.length,connected:a.filter(s=>String(s.status||s.state).toUpperCase()==="WORKING").length}))})
      .catch(()=>process.exit(2));'
}

before_counts="$(session_counts)"
expected_registered="$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["registered"])' "$before_counts")"
expected_connected="$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["connected"])' "$before_counts")"
[[ "$expected_registered" -eq "$expected_connected" ]] || {
  echo "Existem sessões WAHA não operacionais; atualização bloqueada antes de qualquer parada." >&2
  exit 2
}
current_image="$(docker inspect -f '{{.Config.Image}}' "$waha_id")"
session_volume="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/.sessions"}}{{.Name}}{{end}}{{end}}' "$waha_id")"
[[ -n "$current_image" && -n "$session_volume" ]] || { echo "Imagem ou volume WAHA não identificado." >&2; exit 2; }

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
override_file="$state_dir/waha-release.override.yml"
rollback_file="$state_dir/waha-rollback.override.yml"
backup_file="$backup_dir/waha-sessions-${timestamp}.tar.gz.enc"
printf 'services:\n  waha:\n    image: %s\n    pull_policy: never\n' "$candidate_image" > "$override_file"
printf 'services:\n  waha:\n    image: %s\n    pull_policy: never\n' "$current_image" > "$rollback_file"
chmod 0600 "$override_file" "$rollback_file"

"${compose[@]}" stop -t 30 waha
docker run --rm --volume "$session_volume:/source:ro" alpine:3.20 tar -cz -C /source . \
  | openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:WAHA_BACKUP_ENCRYPTION_KEY -out "$backup_file"
chmod 0600 "$backup_file"

promote_failed=true
"${compose[@]}" -f "$override_file" up -d --no-deps --no-build waha
for _ in $(seq 1 30); do
  if after_counts="$(session_counts 2>/dev/null)"; then
    if python3 -c 'import json,sys;a=json.loads(sys.argv[1]);sys.exit(0 if a["registered"]==int(sys.argv[2]) and a["connected"]==int(sys.argv[3]) else 1)' "$after_counts" "$expected_registered" "$expected_connected"; then
      promote_failed=false
      break
    fi
  fi
  sleep 3
done

if [[ "$promote_failed" = false ]]; then
  updated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  write_release_state "$stable_version" automatic "$updated_at"
  find "$backup_dir" -type f -name 'waha-sessions-*.tar.gz.enc' -mtime +30 -delete
  echo "WAHA atualizado com sessões preservadas: $current_version -> $stable_version."
  exit 0
fi

echo "WAHA não restaurou todas as sessões; aplicando rollback automático." >&2
"${compose[@]}" stop -t 30 waha || true
"${compose[@]}" -f "$rollback_file" up -d --no-deps --no-build waha
for _ in $(seq 1 30); do
  if rollback_counts="$(session_counts 2>/dev/null)"; then
    if python3 -c 'import json,sys;a=json.loads(sys.argv[1]);sys.exit(0 if a["registered"]==int(sys.argv[2]) and a["connected"]==int(sys.argv[3]) else 1)' "$rollback_counts" "$expected_registered" "$expected_connected"; then
      write_release_state "$current_version" rollback "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      echo "Rollback WAHA restaurado em $current_version." >&2
      exit 1
    fi
  fi
  sleep 3
done

echo "Falha crítica: rollback não restaurou as sessões. Backup cifrado preservado em $backup_file." >&2
exit 1
