# Design Decisions

This note captures the trade-offs most likely to matter in a design review or interview. The
project deliberately favors a bounded, transparent routing system over global coverage or an
opaque third-party directions API.

## Custom pathfinding, with the graph held in memory

PostGIS owns durable OSM nodes and edges and performs indexed nearest-node snapping. At process
startup, the API and worker load that graph into an adjacency list so Dijkstra and A* do not issue
database queries inside their search loops. This spends memory per process and makes graph updates
require a restart, but gives predictable traversal latency and keeps the algorithm implementation
easy to inspect. A larger deployment would version graph snapshots or use a shared routing engine.

A binary min-heap keeps both searches at `O((V + E) log V)` worst-case time and `O(V)` space. A*
uses great-circle distance to the goal. That heuristic is admissible because ingested edge weights
are segment distances, so the straight-line distance cannot exceed the length of a road path.

## Nearest-neighbor plus 2-opt instead of exact TSP

Exact TSP grows factorially and is unsuitable for an interactive 25-stop cap. Nearest-neighbor
quickly builds a valid `O(n^2)` visiting order; 2-opt then removes crossing or otherwise inefficient
edge pairs. The improvement phase has a 500 ms wall-clock budget, trading proof of optimality for a
bounded response time. On the deterministic eight-stop validation fixture, the heuristic matched
the brute-force optimum (0.00% gap), but that result is a quality check rather than a universal
guarantee.

## Asynchronous processing above 15 stops

Requests with 2-15 stops run synchronously because they fit the product's two-second interaction
budget on the target graph. At 16-25 stops, pairwise searches and 2-opt have enough tail-latency
risk to make a long HTTP request fragile, so the API returns `202 Accepted` and a job ID. BullMQ
provides durable Redis-backed work distribution, a separate worker protects API responsiveness,
and PostgreSQL persists status and results. Jobs get three total attempts (two retries) with
exponential backoff. Polling is the compatibility baseline; Redis Pub/Sub feeds WebSocket updates
for a more responsive client.

## Redis for both cache and queue infrastructure

Redis supplies low-latency expiring response storage as well as BullMQ's queue substrate. Reusing
one operational dependency is appropriate for a local/demo system, although production could
separate cache and queue instances to isolate memory pressure and failure domains. Cache failures
are fail-open: route computation continues and the response is returned uncached.

Cache keys round coordinates to five decimal places and include the algorithm. Multi-stop keys
preserve input order because the naive comparison and returned stop indices are order-sensitive;
sorting those stops would create incorrect cache hits.

## Static travel-time estimates

The MVP minimizes distance on static OSM-derived weights and converts distance to duration using a
fixed average speed. This keeps the pathfinding objective and A* heuristic internally consistent,
but it is not traffic-aware or suitable for turn-by-turn navigation. Per-road-class speeds are
retained during ingestion so time-weighted routing can be added later.

## Containers, readiness, and observability

Compose treats dependency readiness explicitly: Postgres and Redis must be healthy before the
one-shot migration runs; API and worker wait for migration plus Redis; frontend waits for a healthy
API. Long-running services restart unless stopped. Pino emits JSON request/response logs, and job
events include job ID, state, attempt, and route ID where available. This is intentionally lighter
than a metrics/tracing stack, but it meets the local/demo observability requirement without adding
another service.
