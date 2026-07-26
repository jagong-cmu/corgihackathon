.PHONY: up down migrate rollback status seed demo verify reset test psql logs

COMPOSE := docker compose -f docker-compose.yml

## Bring up Postgres and apply every migration.
up:
	$(COMPOSE) up -d --wait postgres
	$(COMPOSE) up migrate

## Stop everything, keeping the volume.
down:
	$(COMPOSE) down

migrate:
	$(COMPOSE) run --rm migrate up

## Roll back one migration: make rollback N=3 for three.
rollback:
	$(COMPOSE) run --rm migrate down $(or $(N),1)

status:
	$(COMPOSE) run --rm migrate status

## Seed the persona library from apps/agent/personas and assert the round-trip.
seed:
	$(COMPOSE) --profile tools run --rm seed

## Same, plus a demo user/session/turns/snapshot/sim/event.
demo:
	$(COMPOSE) --profile tools run --rm seed --demo

## Roll every migration back and prove nothing is left behind.
verify:
	$(COMPOSE) run --rm migrate down all
	$(COMPOSE) run --rm migrate verify-empty

## Nuke the volume and rebuild from zero.
reset:
	$(COMPOSE) down -v
	$(MAKE) up

## The full DONE-WHEN check: up, seed, roll back, prove empty, then up again.
test:
	$(MAKE) reset
	$(MAKE) seed
	$(MAKE) verify
	$(MAKE) migrate
	@echo "infra: migrations apply, personas round-trip, rollback leaves an empty database"

psql:
	$(COMPOSE) exec -e PGPASSWORD=$${POSTGRES_PASSWORD:-tutor} postgres \
		psql -U $${POSTGRES_USER:-tutor} -d $${POSTGRES_DB:-tutor}

logs:
	$(COMPOSE) logs -f postgres
