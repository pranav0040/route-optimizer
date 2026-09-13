# Repository Guidelines

## Project Structure & Module Organization

This pnpm workspace contains two TypeScript packages. `backend/src/` holds the Express API, worker, database access, road graph, and routing algorithms. Utilities live in `backend/scripts/`, SQL migrations in `backend/db/migrations/`, declarations in `backend/types/`, and Vitest suites in `backend/tests/`. `frontend/src/app/` contains the standalone Angular application; bootstrap files remain under `frontend/src/`, while static assets belong in `frontend/public/`. Requirements are in `docs/`. Local services are defined in `docker-compose.yml`.

## Build, Test, and Development Commands

- `pnpm install` — install all workspace dependencies from the repository root.
- `docker compose up --build` — build and run the complete local stack.
- `pnpm --filter route-optimizer-backend dev` — start the API with reload.
- `pnpm --filter route-optimizer-backend worker:dev` — run the worker in watch mode.
- `pnpm --filter frontend start` — serve Angular at `http://localhost:4200`.
- `pnpm --filter route-optimizer-backend test` — run backend Vitest tests once.
- `pnpm --filter frontend test` — run Angular/Jasmine tests.
- `pnpm lint` / `pnpm build` — lint or build both packages.
- `pnpm --filter route-optimizer-backend migrate` — apply database migrations.

## Coding Style & Naming Conventions

Use TypeScript with two-space indentation, single quotes, and semicolons; keep lines near the frontend Prettier limit of 100 characters. Name files in kebab-case (`nearest-node.ts`), classes and types in PascalCase, and functions/variables in camelCase. Angular selectors must use the `app` prefix: kebab-case for components and camelCase for directives. Backend imports should use `import type` where applicable. Run ESLint before submitting; use `pnpm --filter route-optimizer-backend format` for backend formatting.

## Testing Guidelines

Place backend tests in `backend/tests/` as `*.test.ts`; colocate Angular tests as `*.spec.ts`. Add focused tests for normal, boundary, and failure cases, especially disconnected graphs and zero-distance routes. No coverage threshold is configured, so changes should still include meaningful regression coverage.

## Commit & Pull Request Guidelines

Git history is unavailable in this snapshot. Use concise, imperative Conventional Commit-style subjects, such as `feat: add route endpoint` or `fix: handle disconnected graph`. Pull requests should explain scope and behavior, link relevant issues, list verification commands, and note schema or environment changes. Include screenshots for visible UI changes and never commit `.env`, database dumps, or large OSM extracts.

## Configuration & Security

Copy `.env.example` to `.env` for local configuration. Keep credentials out of source control, preserve safe development defaults in the example file, and document every new environment variable.
