.PHONY: up down migrate seed dev web test eval-small eval eval-replay lint typecheck

up:
	docker compose up -d --wait
	@echo "compose: postgres :5433  redis :6380"

down:
	docker compose down

migrate:
	pnpm run db:migrate

seed:
	pnpm run seed

dev:
	@echo "not implemented"

web:
	pnpm web

test:
	pnpm test

typecheck:
	pnpm run typecheck

lint:
	pnpm run lint

eval-small:
	@echo "not implemented"

eval:
	@echo "not implemented"

eval-replay:
	@echo "not implemented"
