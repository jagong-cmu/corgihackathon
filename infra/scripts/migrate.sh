#!/usr/bin/env bash
#
# Forward-only SQL migration runner.
#
#   ./migrate.sh up [N]        apply the next N pending migrations (default: all)
#   ./migrate.sh down [N|all]  roll back the last N applied migrations (default: 1)
#   ./migrate.sh status        what is applied, what is pending
#   ./migrate.sh redo          down 1, then up 1
#   ./migrate.sh verify-empty  assert the database holds no schema objects
#
# Each migration runs inside one transaction together with its bookkeeping row,
# so a failure leaves neither half-applied SQL nor a lying ledger.
#
# psql comes from the host if it is installed, otherwise from the compose
# container — so this works with or without Postgres client tools locally.

set -euo pipefail

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="$INFRA_DIR/migrations"
COMPOSE_FILE="$INFRA_DIR/docker-compose.yml"

PGUSER_="${POSTGRES_USER:-tutor}"
PGDB_="${POSTGRES_DB:-tutor}"
PGPASS_="${POSTGRES_PASSWORD:-tutor}"
PGPORT_="${POSTGRES_PORT:-5432}"
DB_URL="${DATABASE_URL:-postgres://$PGUSER_:$PGPASS_@localhost:$PGPORT_/$PGDB_}"

if command -v psql >/dev/null 2>&1; then
    PSQL=(psql "$DB_URL" -v ON_ERROR_STOP=1 -X -q)
else
    PSQL=(docker compose -f "$COMPOSE_FILE" exec -T
          -e "PGPASSWORD=$PGPASS_" postgres
          psql -U "$PGUSER_" -d "$PGDB_" -v ON_ERROR_STOP=1 -X -q)
fi

sql() { "${PSQL[@]}" -Atc "$1"; }
run_stdin() { "${PSQL[@]}" -f -; }

die() { echo "migrate: $*" >&2; exit 1; }

# --- the ledger ------------------------------------------------------------
#
# Created here rather than in 0001, so that rolling every migration back can drop
# it too and leave a genuinely empty database.

ensure_ledger() {
    sql "CREATE TABLE IF NOT EXISTS schema_migrations (
             version    text PRIMARY KEY,
             name       text NOT NULL,
             applied_at timestamptz NOT NULL DEFAULT now()
         );" >/dev/null
}

drop_ledger_if_drained() {
    local remaining
    remaining="$(sql "SELECT count(*) FROM schema_migrations")"
    if [[ "$remaining" == "0" ]]; then
        sql "DROP TABLE schema_migrations" >/dev/null
        echo "  ledger drained; dropped schema_migrations"
    fi
}

ledger_exists() {
    [[ "$(sql "SELECT to_regclass('public.schema_migrations') IS NOT NULL")" == "t" ]]
}

applied_versions() {
    ledger_exists || return 0
    sql "SELECT version FROM schema_migrations ORDER BY version"
}

# --- migration files -------------------------------------------------------

all_versions() {
    local f base
    for f in "$MIGRATIONS_DIR"/*.up.sql; do
        base="$(basename "$f" .up.sql)"
        echo "${base%%_*}"
    done | sort
}

file_for() {  # file_for <version> <up|down>
    local match
    match=$(find "$MIGRATIONS_DIR" -maxdepth 1 -name "$1_*.$2.sql" | head -n1)
    [[ -n "$match" ]] || die "no $2 migration for version $1"
    echo "$match"
}

name_for() {
    local f
    f="$(file_for "$1" up)"
    basename "$f" .up.sql
}

pending_versions() {
    local applied
    applied="$(applied_versions)"
    local v
    for v in $(all_versions); do
        grep -qxF "$v" <<<"$applied" || echo "$v"
    done
}

# --- commands --------------------------------------------------------------

cmd_up() {
    local limit="${1:-999}"
    ensure_ledger
    local pending count=0
    pending="$(pending_versions)"
    [[ -n "$pending" ]] || { echo "up to date"; return 0; }

    local v name
    for v in $pending; do
        (( count < limit )) || break
        name="$(name_for "$v")"
        echo "  up   $name"
        {
            echo "BEGIN;"
            cat "$(file_for "$v" up)"
            echo ";"
            echo "INSERT INTO schema_migrations (version, name) VALUES ('$v', '$name');"
            echo "COMMIT;"
        } | run_stdin
        count=$((count + 1))
    done
    echo "applied $count migration(s)"
}

cmd_down() {
    local arg="${1:-1}"
    ledger_exists || { echo "nothing applied"; return 0; }

    local applied limit
    applied="$(applied_versions | sort -r)"
    [[ -n "$applied" ]] || { echo "nothing applied"; drop_ledger_if_drained; return 0; }
    if [[ "$arg" == "all" ]]; then limit=999; else limit="$arg"; fi

    local v name count=0
    for v in $applied; do
        (( count < limit )) || break
        name="$(name_for "$v")"
        echo "  down $name"
        {
            echo "BEGIN;"
            cat "$(file_for "$v" down)"
            echo ";"
            echo "DELETE FROM schema_migrations WHERE version = '$v';"
            echo "COMMIT;"
        } | run_stdin
        count=$((count + 1))
    done
    echo "rolled back $count migration(s)"
    drop_ledger_if_drained
}

cmd_status() {
    local applied
    applied="$(applied_versions)"
    local v
    for v in $(all_versions); do
        if grep -qxF "$v" <<<"$applied"; then
            printf '  [x] %s\n' "$(name_for "$v")"
        else
            printf '  [ ] %s\n' "$(name_for "$v")"
        fi
    done
}

# Proves the DONE-WHEN condition: down-all leaves nothing behind. Counts tables,
# views, sequences, user types, user functions and our extensions in the public
# schema — anything a migration could have created.
cmd_verify_empty() {
    local leftovers
    leftovers="$(sql "
        WITH objs AS (
            SELECT 'table/view: ' || c.relname AS what
              FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','S','p')
            UNION ALL
            SELECT 'type: ' || t.typname
              FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
             WHERE n.nspname = 'public' AND t.typtype = 'e'
            UNION ALL
            SELECT 'function: ' || p.proname
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public'
            UNION ALL
            SELECT 'extension: ' || extname
              FROM pg_extension WHERE extname IN ('vector','citext')
        )
        SELECT what FROM objs ORDER BY 1;")"

    if [[ -n "$leftovers" ]]; then
        echo "database is NOT empty:" >&2
        sed 's/^/  /' <<<"$leftovers" >&2
        exit 1
    fi
    echo "database is empty — every migration rolled back cleanly"
}

case "${1:-status}" in
    up)           shift; cmd_up "$@" ;;
    down)         shift; cmd_down "$@" ;;
    redo)         cmd_down 1; cmd_up 1 ;;
    status)       cmd_status ;;
    verify-empty) cmd_verify_empty ;;
    *)            die "unknown command '${1}'. Try: up | down | redo | status | verify-empty" ;;
esac
