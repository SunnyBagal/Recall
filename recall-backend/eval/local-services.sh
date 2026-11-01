#!/usr/bin/env bash
# Private, loopback-only Postgres (with pgvector) and Redis for tests and the
# eval. Separate data directory and non-default ports, so it cannot collide with
# (or be mistaken for) any other database on this machine.
#
#   eval/local-services.sh start | stop | status | urls
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DATA="$HERE/.services"
PG_PORT=54329
REDIS_PORT=63799
PG_BIN="$(brew --prefix postgresql@17)/bin"

case "${1:-}" in
  start)
    mkdir -p "$DATA"
    if [ ! -f "$DATA/pg/PG_VERSION" ]; then
      "$PG_BIN/initdb" -D "$DATA/pg" -U recall --auth=trust --encoding=UTF8 --locale=C >/dev/null
    fi
    if ! "$PG_BIN/pg_ctl" -D "$DATA/pg" status >/dev/null 2>&1; then
      # shared_buffers is pinned so latency runs are comparable between machines
      # and reruns; everything else is the Postgres default.
      "$PG_BIN/pg_ctl" -D "$DATA/pg" -w -l "$DATA/pg.log" \
        -o "-p $PG_PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories='$DATA' -c shared_buffers=512MB" start >/dev/null
    fi
    for db in recall_test recall_eval; do
      "$PG_BIN/psql" -h 127.0.0.1 -p "$PG_PORT" -U recall -d postgres -tAc \
        "select 1 from pg_database where datname='$db'" | grep -q 1 \
        || "$PG_BIN/createdb" -h 127.0.0.1 -p "$PG_PORT" -U recall "$db"
      "$PG_BIN/psql" -h 127.0.0.1 -p "$PG_PORT" -U recall -d "$db" -qc \
        "create extension if not exists vector" >/dev/null
    done
    if ! redis-cli -h 127.0.0.1 -p "$REDIS_PORT" ping >/dev/null 2>&1; then
      redis-server --port "$REDIS_PORT" --bind 127.0.0.1 --daemonize yes \
        --dir "$DATA" --save "" --appendonly no --logfile "$DATA/redis.log" >/dev/null
    fi
    "$0" status
    ;;
  stop)
    "$PG_BIN/pg_ctl" -D "$DATA/pg" -m fast stop >/dev/null 2>&1 || true
    redis-cli -h 127.0.0.1 -p "$REDIS_PORT" shutdown nosave >/dev/null 2>&1 || true
    ;;
  status)
    "$PG_BIN/psql" -h 127.0.0.1 -p "$PG_PORT" -U recall -d recall_eval -tAc \
      "select 'postgres ' || current_setting('server_version') || ', pgvector ' || extversion from pg_extension where extname='vector'"
    echo "redis $(redis-cli -h 127.0.0.1 -p "$REDIS_PORT" ping)"
    ;;
  urls)
    echo "export TEST_DATABASE_URL=postgresql://recall@127.0.0.1:$PG_PORT/recall_test"
    echo "export EVAL_DATABASE_URL=postgresql://recall@127.0.0.1:$PG_PORT/recall_eval"
    echo "export EVAL_REDIS_URL=redis://127.0.0.1:$REDIS_PORT"
    ;;
  *)
    echo "usage: $0 start|stop|status|urls" >&2
    exit 2
    ;;
esac
