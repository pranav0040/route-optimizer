# Route Optimizer

Route Optimizer is a self-hosted delivery-route planner that computes shortest paths on an
OpenStreetMap-derived road graph and improves a 2-25-stop visiting order with nearest-neighbor plus
2-opt. The project implements its own Dijkstra, A*, binary heap, and TSP heuristic rather than
wrapping a directions API. An Express API, Angular/Leaflet client, PostGIS, Redis cache, and BullMQ
worker form the complete application.

The MVP is intentionally bounded to one ingested metro area and one vehicle. It emphasizes
transparent algorithms, measurable trade-offs, responsive background processing, and
production-style engineering practices over global coverage or live traffic.

## Architecture

```mermaid
flowchart LR
browser[Angular + Leaflet client] -->|REST / WebSocket| api[Express API]
  api -->|cached, throttled address lookup| geocoder[Configurable Nominatim service]
  api -->|snap coordinates / persist jobs| db[(PostgreSQL + PostGIS)]
  api -->|Dijkstra / A* / 2-opt| graph[In-memory road graph]
  api -->|cache / enqueue| redis[(Redis)]
  redis -->|BullMQ jobs| worker[Optimization worker]
  worker --> graph
  worker -->|persist result| db
  worker -->|status Pub/Sub| redis
  redis -->|status events| api
```

PostGIS stores OSM nodes and edges and performs indexed nearest-node searches within the configured
500 m snap radius. API and worker processes load the graph into adjacency lists at startup and prefer
the largest strongly connected road component when snapping coordinates. The map boundary is loaded
from that routable component at runtime. The API handles validation, rate limiting, cache lookup,
synchronous computation, polling, and WebSocket
connections. Requests above 15 stops are persisted and queued in Redis; the worker computes them,
stores the result in PostgreSQL, and publishes lifecycle events back to the API. Pino writes JSON
request/response and job lifecycle logs.

The algorithmic costs are documented in code: Dijkstra and A* are
`O((V + E) log V)` time/`O(V)` space with a binary heap; nearest-neighbor is `O(n^2)` pair
selection; each 2-opt pass is `O(n^2)` and the search is bounded by 500 ms. See
[Design Decisions](docs/DESIGN_DECISIONS.md) for the trade-offs behind those choices.

## Repository Layout

- `backend/src/algorithms/` — custom pathfinding, heap, and route optimization.
- `backend/src/` — Express API, WebSocket server, cache, database, queue, and worker modules.
- `backend/scripts/` — migrations, OSM ingestion, pathfinding benchmark, and load test.
- `backend/db/migrations/` — PostGIS graph and durable route/job schemas.
- `backend/tests/` — algorithm unit tests and backend integration tests.
- `frontend/src/app/` — standalone Angular route builder, map, job view, and typed services.
- `docs/` — PRD, SRS, design decisions, and recorded benchmark results.
- `.github/workflows/ci.yml` — ordered lint, test, and build pipeline.
- `docker-compose.yml` — complete local stack and readiness ordering.

## Setup

Prerequisites: Docker Desktop/Engine with Compose, or Node.js 22+ and pnpm 11 for host-based
development.

1. Copy the environment template. The checked-in defaults are safe for local development; do not
   commit `.env`.

   ```powershell
   Copy-Item .env.example .env
   ```

   `CARTO_BASEMAP_KEY` is optional. Core routing has no paid API dependency, and the default CARTO
   Voyager tiles retain OpenStreetMap/CARTO attribution and provide higher-contrast road context.
   Address entry uses configurable geocoding endpoints. Exact and reverse lookup default to
   OpenStreetMap Nominatim, while prefix suggestions use Photon. All lookups are restricted to the loaded Bengaluru
   bounds, cached in Redis, identified with `GEOCODER_USER_AGENT`, and serialized to keep external
   usage modest.

2. Install workspace dependencies when running checks or services on the host.

   ```sh
   pnpm install --frozen-lockfile
   ```

3. Build and start PostGIS, Redis, the migration job, API, worker, and frontend.

   ```sh
   docker compose up --build
   ```

   Compose waits for healthy Postgres and Redis before running migrations; API and worker wait for
   the migration to succeed; frontend waits for the API health check. Open the UI at
   `http://localhost:4200` and health endpoint at `http://localhost:3000/api/health`.

4. Provision the bounded road graph once before requesting real routes. Put a metro `.osm.pbf`
   extract in `data/` (extracts are git-ignored). The checked-out development environment uses a
   bounded Bengaluru extract covering `12.90,77.54` to `13.03,77.72`:

   ```sh
   docker compose run --rm migrate node dist/scripts/ingest-osm.js /data/Bengaluru.osm.pbf
   docker compose restart api worker
   ```

   The verified Bengaluru import contains 150,265 nodes and 317,487 directed edges; 148,646 nodes
   (98.9%) belong to its largest connected component. It was exported from
   [OpenStreetMap](https://www.openstreetmap.org/copyright) through Overpass and is covered by the
   Open Database License. The exact bounded query is retained at
   `backend/scripts/bengaluru-roads.overpassql` so the extract can be regenerated.

   The restart is required because both processes load the graph at startup. Re-running
   `docker compose up` later uses the persisted Postgres and Redis volumes. Stop the stack with
   `docker compose down`; add `--volumes` only when intentionally discarding local data.

### Host development

With Postgres/Redis available and `DATABASE_URL`/`REDIS_URL` pointing at them:

```sh
pnpm --filter route-optimizer-backend migrate
pnpm --filter route-optimizer-backend dev
pnpm --filter route-optimizer-backend worker:dev
pnpm --filter frontend start
```

## API Examples

### Address search

```sh
curl "http://localhost:3000/api/geocoding/search?address=Cubbon%20Park%2C%20Bengaluru"
```

The route builder can use an address or decimal latitude/longitude independently for the starting
point and every stop. Suggestions appear automatically after three characters; press Enter or
choose **Find address** to search immediately. Selecting a
match immediately places the origin or stop on the map. Clicking inside the map boundary reverse
geocodes the point and adds its address to the delivery-stop list. Address matches are converted to
coordinates before the existing route API runs. The default geocoder bounds match the Bengaluru
road extract; configure `GEOCODER_VIEWBOX` and `GEOCODER_COUNTRY_CODES` when loading a different
metro graph.

### Point-to-point route

```sh
curl -X POST http://localhost:3000/api/routes/point-to-point \
  -H "Content-Type: application/json" \
  -d '{"origin":{"lat":12.9716,"lng":77.5946},"destination":{"lat":12.9352,"lng":77.6146},"algorithm":"astar"}'
```

Verified abridged response (the 206-coordinate `path` is omitted here):

```json
{
  "distance_m": 5477.8746222683,
  "duration_s": 394,
  "algorithm": "astar",
  "cached": false
}
```

Choose `dijkstra` or `astar`. A request whose coordinates cannot snap to the loaded graph, or whose
snapped nodes are disconnected, returns `422` with the shared JSON error shape.

### Multi-stop optimization

```sh
curl -X POST http://localhost:3000/api/routes/optimize \
  -H "Content-Type: application/json" \
  -d '{"origin":{"lat":12.9716,"lng":77.5946},"stops":[{"lat":12.9611,"lng":77.6387},{"lat":12.9352,"lng":77.6146}]}'
```

For 2-15 stops, the API returns `200` with `optimized_order`, `optimized_path`, distance/duration,
the naive path and totals, percentage improvement, and cache status. Stop indices refer to the
submitted array and are zero-based.

Verified abridged response (the 363- and 324-coordinate path arrays are omitted here):

```json
{
  "optimized_order": [1, 0],
  "total_distance_m": 11150.862787398391,
  "total_duration_s": 803,
  "naive_distance_m": 12080.59470895243,
  "naive_duration_s": 870,
  "improvement_pct": 7.7,
  "cached": false
}
```

For 16-25 stops, the API returns `202` immediately:

```json
{ "job_id": "b3f1c9...", "status": "queued", "cached": false }
```

Poll `GET /api/jobs/{job_id}` or connect to `ws://localhost:3000/ws/jobs/{job_id}`. Terminal states
are `completed` (with `route_id`) and `failed` (with `error_reason`). More than 25 stops is rejected
with `400`.

All endpoint errors use:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "stops: ..." } }
```

## Quality Gates and CI

GitHub Actions runs on every push and pull request, in strict dependency order:

1. backend/frontend ESLint plus Prettier checks;
2. backend algorithm unit tests with 80% coverage thresholds;
3. backend API/cache/job/WebSocket integration tests;
4. Angular unit tests in ChromeHeadless;
5. backend and production frontend builds.

Run the same gates locally:

```sh
pnpm lint
pnpm format:check
pnpm test:backend:unit
pnpm test:backend:integration
pnpm test:frontend
pnpm build
```

The final algorithm suite measured 94.02% statements, 84.41% branches, 100% functions, and 93.85%
lines, enforcing SRS NFR-9 rather than only reporting coverage.

## Benchmarks

These are single-machine engineering baselines, not production SLAs. Both deterministic fixtures
are included so reviewers can reproduce the measurements without the uncommitted OSM extract.

### Stage 2 — Dijkstra vs. A*

One hundred identical source/destination pairs ran on a deterministic 50,176-node,
199,808-directed-edge grid. All 100 pairs were reachable.

| Algorithm | Average latency | Average nodes explored |
|---|---:|---:|
| Dijkstra | 17.23 ms | 23,603.62 |
| A* | 15.04 ms | 14,104.81 |

A* was 12.7% faster and explored 40.2% fewer nodes on this run. Reproduce with
`BENCHMARK_FIXTURE=true pnpm --filter route-optimizer-backend benchmark:pathfinding 100`; omit the
environment flag to benchmark the ingested PostGIS graph.

### Stage 3 — TSP heuristic quality

On the deterministic eight-stop metric fixture, nearest-neighbor plus bounded 2-opt produced the
same distance as exhaustive brute force: **0.00% optimality gap**. The regression test accepts no
more than a 5% gap. This validates that fixture and the implementation; it does not claim a general
approximation guarantee for 2-opt.

### Final stage — concurrent HTTP load

Autocannon exercised uncached `POST /api/routes/point-to-point` requests for 15 seconds with 20
connections against the deterministic 50,176-node fixture.

| Requests | Throughput | Avg | p90 | p97.5 | p99 | Max | Errors/timeouts/non-2xx |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 31,980 | 2,132.74 req/s | 8.92 ms | 11 ms | 13 ms | 19 ms | 77 ms | 0 / 0 / 0 |

Because Autocannon reported p97.5 at 13 ms, p95 was no greater than 13 ms in this run, below the
300 ms NFR-1 cache-miss target. Full method, environment, limitations, and reproduction commands
are in the [load-test record](docs/benchmarks/2026-09-11-load-test.md).

## P0 Feature Status

Every PRD Section 6 P0 feature is implemented and covered by code/tests:

| ID | Feature | Implementation evidence |
|---|---|---|
| F1 | Point-to-point routing | Validated REST endpoint, 500 m PostGIS snapping, distance, duration, and road geometry |
| F2 | Multi-stop optimization | 2-25 stops, ordered full geometry, totals, naive comparison, stop-limit validation |
| F3 | Self-implemented pathfinding | Custom Dijkstra, A*, binary min-heap, disconnected and zero-distance tests |
| F4 | TSP heuristic | Nearest-neighbor construction, request-scoped pair cache, 500 ms-bounded 2-opt, brute-force comparison |
| F5 | Async job processing | BullMQ worker above 15 stops, persistence, polling, WebSocket updates, two retries, failure reasons |
| F6 | Response caching | Redis, normalized order-sensitive SHA-256 keys, 24-hour default TTL, visible cache-hit flag, fail-open behavior |
| F7 | Interactive map UI | Address, coordinate, and map-click entry, add/remove controls, loading/job states, Leaflet route rendering and summaries |

NFR-9 through NFR-12 are likewise represented: enforced algorithm coverage, lint/format CI gates,
single-command Compose startup with health-based ordering, and structured request/job lifecycle
logging. P1 naive-versus-optimized visualization is also implemented. Fleet routing, capacity/time
windows, live traffic, accounts, exports, and global map coverage remain intentionally out of MVP
scope.

## Project Status

Final MVP engineering stage complete. The CI pipeline, container stack, load-test harness and
record, final documentation, design-decision notes, algorithm coverage gate, structured logging,
full route geometry, and cache-order correctness fix are in place. The deployment-specific PBF is
git-ignored by design. On 2026-09-11, a bounded Bengaluru graph (150,265 nodes, 317,487 directed
edges) was loaded into PostGIS; API and worker both loaded it successfully. The live Compose stack
passed health checks for Postgres, Redis, API, worker, and frontend, including Nginx REST/WebSocket
proxy paths, all three migrations, a 5.48 km point-to-point route, and a two-stop optimized route.
