#!/usr/bin/env bash
set -euo pipefail

exec 9>/run/lock/mentorian-evolution-auto-update.lock
flock --nonblock 9 || { echo "Outra atualização Evolution já está em andamento."; exit 0; }

state_dir="${EVOLUTION_UPDATE_STATE_DIR:-/var/lib/mentorian-evolution-update}"
backup_dir="$state_dir/backups"
mkdir -p "$backup_dir"
chmod 0700 "$state_dir" "$backup_dir"
[[ -n "${EVOLUTION_BACKUP_ENCRYPTION_KEY:-}" && ${#EVOLUTION_BACKUP_ENCRYPTION_KEY} -ge 32 ]] || {
  echo "EVOLUTION_BACKUP_ENCRYPTION_KEY ausente ou curta; atualização bloqueada." >&2
  exit 2
}

evolution_id="$(docker ps -q --filter label=com.docker.compose.service=evolution | head -n1)"
postgres_id="$(docker ps -q --filter label=com.docker.compose.service=postgres | head -n1)"
broker_id="$(docker ps -q --filter label=com.docker.compose.service=broker | head -n1)"
[[ -n "$evolution_id" && -n "$postgres_id" && -n "$broker_id" ]] || {
  echo "Evolution, Postgres ou broker não está em execução." >&2
  exit 2
}

workdir="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$evolution_id")"
config_files="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' "$evolution_id")"
project="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$evolution_id")"
[[ -n "$workdir" && -n "$config_files" && -n "$project" ]] || {
  echo "Metadados Compose ausentes." >&2
  exit 2
}
cd "$workdir"

compose=(docker compose -p "$project")
IFS=',' read -r -a compose_file_list <<< "$config_files"
for compose_file in "${compose_file_list[@]}"; do compose+=(-f "$compose_file"); done

release_json="$(curl --fail --silent --show-error https://api.github.com/repos/evolution-foundation/evolution-api/releases/latest)"
stable_version="$(python3 -c 'import json,sys,re; r=json.loads(sys.argv[1]); v=str(r.get("tag_name", "")).removeprefix("v"); assert not r.get("draft") and not r.get("prerelease") and re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", v); print(v)' "$release_json")"
current_version="$(docker exec "$broker_id" node -e 'const fs=require("fs");let v="";try{v=JSON.parse(fs.readFileSync("/config/provider-release-state.json","utf8")).providers.evolution.installedVersion||""}catch{};process.stdout.write(v||process.env.EVOLUTION_VERSION||process.env.EVO_VERSION||"2.3.7")')"
[[ "$current_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "Versão Evolution instalada inválida." >&2
  exit 2
}

write_release_state() {
  local version="$1" source="$2" updated_at="$3"
  docker exec -e RELEASE_VERSION="$version" -e RELEASE_SOURCE="$source" -e RELEASE_UPDATED_AT="$updated_at" "$broker_id" node -e '
    const fs=require("fs"), file="/config/provider-release-state.json", temp=`${file}.tmp`;
    let state={version:1,providers:{}}; try{state=JSON.parse(fs.readFileSync(file,"utf8"))}catch{}
    state.version=1; state.providers=state.providers&&typeof state.providers==="object"?state.providers:{};
    state.providers.evolution={installedVersion:process.env.RELEASE_VERSION,releaseChannel:"stable",automaticUpdates:true,lastUpdatedAt:process.env.RELEASE_UPDATED_AT,lastUpdateSource:process.env.RELEASE_SOURCE};
    fs.writeFileSync(temp,JSON.stringify(state,null,2),{mode:0o600}); fs.renameSync(temp,file);'
}

if [[ "$current_version" = "$stable_version" ]]; then
  current_updated_at="$(docker exec "$broker_id" node -e 'const fs=require("fs");let d="";try{d=JSON.parse(fs.readFileSync("/config/provider-release-state.json","utf8")).providers.evolution.lastUpdatedAt||""}catch{};process.stdout.write(d||process.env.EVOLUTION_UPDATED_AT||new Date().toISOString())')"
  write_release_state "$current_version" release "$current_updated_at"
  echo "Evolution já está na versão estável $current_version; atualizador confirmado."
  exit 0
fi

evolution_state() {
  docker exec "$broker_id" node -e '
    fetch(`${process.env.EVO_API_URL}/instance/fetchInstances`,{headers:{apikey:process.env.EVO_API_KEY}})
      .then(async r=>{if(!r.ok)throw Error(String(r.status));const b=await r.json();const a=Array.isArray(b)?b:(b.instances||[]);const rows=a.map(x=>x&&x.instance&&typeof x.instance==="object"?x.instance:x).map(x=>({name:String(x.name||x.instanceName||""),connected:String(x.connectionStatus||x.state||x.status||"").toLowerCase()==="open"})).filter(x=>x.name).sort((a,b)=>a.name.localeCompare(b.name));console.log(JSON.stringify(rows))})
      .catch(()=>process.exit(2));'
}

before_state="$(evolution_state)"

candidate_image="ghcr.io/sergiomentorian/evolution-api:${stable_version}-mentorian"
current_image="$(docker inspect -f '{{.Config.Image}}' "$evolution_id")"
docker pull "$candidate_image"
[[ -n "$current_image" ]] || { echo "Imagem Evolution atual não identificada." >&2; exit 2; }

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
override_file="$state_dir/evolution-release.override.yml"
rollback_file="$state_dir/evolution-rollback.override.yml"
backup_file="$backup_dir/evolution-db-${timestamp}.dump.enc"
printf 'services:\n  evolution:\n    image: %s\n    pull_policy: never\n' "$candidate_image" > "$override_file"
printf 'services:\n  evolution:\n    image: %s\n    pull_policy: never\n' "$current_image" > "$rollback_file"
chmod 0600 "$override_file" "$rollback_file"

"${compose[@]}" stop -t 30 evolution
docker exec "$postgres_id" pg_dump -Fc -U postgres evolution_db \
  | openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:EVOLUTION_BACKUP_ENCRYPTION_KEY -out "$backup_file"
chmod 0600 "$backup_file"

promote_failed=true
"${compose[@]}" -f "$override_file" up -d --no-deps --no-build evolution
for _ in $(seq 1 40); do
  if after_state="$(evolution_state 2>/dev/null)"; then
    if python3 -c 'import json,sys;sys.exit(0 if json.loads(sys.argv[1])==json.loads(sys.argv[2]) else 1)' "$after_state" "$before_state"; then
      promote_failed=false
      break
    fi
  fi
  sleep 3
done

if [[ "$promote_failed" = false ]]; then
  write_release_state "$stable_version" automatic "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  find "$backup_dir" -type f -name 'evolution-db-*.dump.enc' -mtime +30 -delete
  echo "Evolution atualizado com instâncias preservadas: $current_version -> $stable_version."
  exit 0
fi

echo "Evolution não restaurou todas as instâncias; restaurando banco e imagem anteriores." >&2
"${compose[@]}" stop -t 30 evolution || true
openssl enc -d -aes-256-cbc -pbkdf2 -pass env:EVOLUTION_BACKUP_ENCRYPTION_KEY -in "$backup_file" \
  | docker exec -i "$postgres_id" pg_restore --clean --if-exists --no-owner --no-privileges -U postgres -d evolution_db
"${compose[@]}" -f "$rollback_file" up -d --no-deps --no-build evolution
for _ in $(seq 1 40); do
  if rollback_state="$(evolution_state 2>/dev/null)"; then
    if python3 -c 'import json,sys;sys.exit(0 if json.loads(sys.argv[1])==json.loads(sys.argv[2]) else 1)' "$rollback_state" "$before_state"; then
      write_release_state "$current_version" rollback "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      echo "Rollback Evolution restaurado em $current_version." >&2
      exit 1
    fi
  fi
  sleep 3
done

echo "Falha crítica: rollback não restaurou as instâncias. Backup cifrado preservado em $backup_file." >&2
exit 1
