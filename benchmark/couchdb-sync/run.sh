#!/bin/sh
set -eu
cd "$(dirname "$0")"
command -v docker >/dev/null || { echo 'Docker 不可用；未运行实验。' >&2; exit 1; }
export COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-couchdb-memory-sync-bench-$(date +%s)-$$}
export RESULTS_DIR="results/$COMPOSE_PROJECT_NAME"
mkdir -p "$RESULTS_DIR"
NET="${COMPOSE_PROJECT_NAME}-sync"
# This experiment intentionally preserves its named volumes for inspection.
[ "$(docker volume ls -q --filter name=${COMPOSE_PROJECT_NAME:-couchdb-memory-sync-bench}_)" = '' ] || { echo '已有实验卷；为避免覆盖历史结果，请先另行处理这些卷。' >&2; exit 1; }
trap 'docker compose logs --no-color 2>&1 | sed -E "s/([0-9]{1,3}\.){3}[0-9]{1,3}/[ip]/g" > "$RESULTS_DIR/compose.log" || true; docker compose down >/dev/null 2>&1 || true' EXIT INT TERM
docker compose up -d --build
A=$(docker compose ps -q a); B=$(docker compose ps -q b); C=$(docker compose ps -q couch)
run() { docker exec "$1" node /app/client.js "$2" ${3+"$3"} ${4+"$4"}; }
# Bounded server readiness check.
i=0; until run "$A" init > "$RESULTS_DIR/system-databases.json" 2>/dev/null; do i=$((i+1)); [ "$i" -lt 60 ] || { echo 'CouchDB 未在时限内就绪' >&2; exit 1; }; sleep 1; done
docker logs "$C" 2>&1 | sed -E "s/([0-9]{1,3}\.){3}[0-9]{1,3}/[ip]/g" > "$RESULTS_DIR/couch-initialization.log"
restart_at=$(node -p 'new Date().toISOString()')
docker restart "$C" >/dev/null
i=0; until run "$A" init > "$RESULTS_DIR/system-databases-after-restart.json" 2>/dev/null; do i=$((i+1)); [ "$i" -lt 60 ] || { echo 'CouchDB 重启后未就绪' >&2; exit 1; }; sleep 1; done
run "$A" uuid-check > "$RESULTS_DIR/uuid-smoke.json"
run "$A" put initial >/dev/null
run "$A" sync >/dev/null; run "$B" sync >/dev/null
for c in "$A" "$B"; do docker exec "$c" du -sk /data; done > $RESULTS_DIR/disk-before-kib.txt
docker exec "$C" du -sk /opt/couchdb/data >> $RESULTS_DIR/disk-before-kib.txt
docker stats --no-stream --format '{{json .}}' "$A" "$B" "$C" | node metrics.js > $RESULTS_DIR/stats-idle.jsonl
# Disconnect running clients; the containers remain running while writes occur.
docker network disconnect "$NET" "$A"
docker network disconnect "$NET" "$B"
run "$A" put source correction > $RESULTS_DIR/offline-written.json
run "$A" put left >/dev/null; run "$B" put right >/dev/null
docker restart "$A" "$B" >/dev/null
docker inspect "$A" "$B" | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{const a=JSON.parse(s).map(x=>({running:x.State.Running,networks:Object.keys(x.NetworkSettings.Networks)}));console.log(JSON.stringify(a));});' > "$RESULTS_DIR/offline-network-inspect.json"
node -e 'const x=require("./"+process.env.RESULTS_DIR+"/offline-network-inspect.json"); if(x.some(c=>!c.running||c.networks.includes(process.env.COMPOSE_PROJECT_NAME+"-sync"))) process.exit(1)'
run "$A" list > $RESULTS_DIR/offline-after-restart-a.json
run "$B" list > $RESULTS_DIR/offline-after-restart-b.json
node verify.js offline
docker network connect "$NET" "$A"
docker network connect "$NET" "$B"
(while :; do docker stats --no-stream --format '{{json .}}' "$A" "$B" "$C" | node metrics.js || break; done) > $RESULTS_DIR/stats-sync.jsonl &
sampler=$!
start=$(node -p 'Date.now()')
run "$A" sync >/dev/null; run "$B" sync >/dev/null; run "$A" sync >/dev/null
end=$(node -p 'Date.now()'); kill "$sampler" 2>/dev/null || true; wait "$sampler" 2>/dev/null || true; echo "$((end-start))" > $RESULTS_DIR/sync-milliseconds.txt
run "$A" project > $RESULTS_DIR/conflict-projection-a.json
run "$B" project > $RESULTS_DIR/conflict-projection-b.json
run "$A" put resolution >/dev/null
run "$A" sync >/dev/null; run "$B" sync >/dev/null; run "$A" sync >/dev/null
run "$A" sync >/dev/null; run "$B" sync >/dev/null
run "$A" list > $RESULTS_DIR/final-a.json; run "$B" list > $RESULTS_DIR/final-b.json; run "$A" list remote > $RESULTS_DIR/final-server.json
run "$A" project > $RESULTS_DIR/final-projection-a.json; run "$B" project > $RESULTS_DIR/final-projection-b.json
node verify.js final
docker stats --no-stream --format '{{json .}}' "$A" "$B" "$C" | node metrics.js > $RESULTS_DIR/stats-after.jsonl
for c in "$A" "$B"; do docker exec "$c" du -sk /data; done > $RESULTS_DIR/disk-after-kib.txt
docker exec "$C" du -sk /opt/couchdb/data >> $RESULTS_DIR/disk-after-kib.txt
docker image inspect couchdb:3.5.3@sha256:907eab5b7e55ab7cfd241d39b90b2a335ea40bef82acee5a37388c08bf201dda node:22.14.0-bookworm-slim@sha256:1c18d9ab3af4585870b92e4dbc5cac5a0dc77dd13df1a5905cea89fc720eb05b | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>console.log(JSON.stringify(JSON.parse(s).map(i=>({tags:i.RepoTags,digests:i.RepoDigests})))));' > "$RESULTS_DIR/images.json"
docker logs --since "$restart_at" "$C" 2>&1 | sed -E "s/([0-9]{1,3}\.){3}[0-9]{1,3}/[ip]/g" > "$RESULTS_DIR/couch-after-restart.log"
if grep -Eq 'changes listener died because the _users database does not exist|Missing system database _users|Request to create N=3 DB' "$RESULTS_DIR/couch-after-restart.log"; then echo '重启后发现初始化告警' >&2; exit 1; fi
echo "实验校验通过；结果位于 ${RESULTS_DIR}。"
