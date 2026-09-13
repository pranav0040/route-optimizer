# Product Requirements Document (PRD)
## Route Optimizer — Multi-Stop Delivery Route Planning Platform

| | |
|---|---|
| **Version** | 1.0 |
| **Status** | Draft |
| **Author** | [Your Name] |
| **Date** | [Insert Date] |
| **Related Docs** | SRS.md (Software Requirements Specification) |

---

## 1. Executive Summary

Route Optimizer is a web application that computes efficient driving routes between an origin and a destination, and — more importantly — determines the optimal order in which to visit a set of multiple stops (e.g. delivery locations) to minimize total distance and travel time. Unlike tools that simply wrap a third-party directions API, this system implements its own graph search and route-optimization algorithms on real road-network data, exposes them through an Express/Node.js REST API, and visualizes them through an Angular single-page application.

The system is built as a portfolio-grade engineering project. Its purpose is twofold: (1) solve a genuine logistics problem — reducing distance/time for multi-stop trips — and (2) demonstrate production-relevant skills: graph algorithms, optimization heuristics, caching, asynchronous processing, geospatial data modeling, and full-stack system design.

---

## 2. Problem Statement

Dispatchers, delivery drivers, and small logistics operators frequently need to visit multiple locations in a single trip. Manually ordering stops, or visiting them in the order they were entered, routinely produces longer, more expensive routes than necessary. This is a variant of the Traveling Salesman Problem (TSP) — computationally hard to solve exactly at scale, but well-suited to fast, high-quality heuristic approaches.

Existing consumer tools (Google Maps, Apple Maps) optimize the order of a handful of stops but are closed-source, rate-limited, costly at volume, and offer no visibility into the algorithm or its trade-offs. There is room for a transparent, self-hosted system that computes both the path *and* the visiting order, with tunable heuristics and observable performance characteristics.

---

## 3. Goals and Objectives

### 3.1 Product Goals
- **G1 — Accurate point-to-point routing**: Compute the shortest path between any two points on a real road network.
- **G2 — Multi-stop optimization**: Given a set of stops, determine a low-cost visiting order (not just a path).
- **G3 — Responsive UX under load**: Keep the UI responsive even when optimization for large stop counts takes several seconds.
- **G4 — Transparency**: Let users compare algorithms/approaches and see the resulting trade-offs (distance, compute time).
- **G5 — Engineering rigor**: Demonstrate testing, caching, async processing, and clean API design suitable for technical review.

### 3.2 Non-Goals (see also Section 6.2)
- Building a commercially viable, revenue-generating SaaS product.
- Matching the routing accuracy or global coverage of Google Maps.

---

## 4. Target Users / Personas

| Persona | Description | Primary Need |
|---|---|---|
| **Dispatcher Dana** | Ops coordinator at a small delivery/courier business planning daily driver routes for 5–25 stops. | Minimize total driver distance/time across all stops. |
| **Driver Dev** | Individual driver or gig-economy courier. | A simple, mobile-friendly view of the optimized stop order. |
| **Reviewer Riley** | Technical interviewer or engineer reviewing the project/codebase. | Evidence of algorithmic depth, system design judgment, and engineering discipline. |

---

## 5. Scope

### 5.1 In Scope (MVP / v1)
- Single-vehicle, single-driver route planning (no fleet assignment).
- Point-to-point shortest-path routing on a real, bounded road network (one metro area).
- Multi-stop order optimization for up to ~25 waypoints.
- Web UI (Angular) with interactive map, stop entry, and route visualization.
- REST API (Express) with caching and async job processing for larger optimization requests.
- Algorithm comparison view (naive order vs. optimized order).

### 5.2 Out of Scope (v1)
- Multi-vehicle fleet routing / driver assignment (true VRP).
- Live traffic ingestion or real-time re-routing.
- Native mobile apps.
- Multi-tenant accounts, billing, or public SaaS hosting.
- Turn-by-turn voice navigation.

### 5.3 Future Considerations (v2+)
- Vehicle capacity and delivery time-window constraints (VRPTW).
- Multi-vehicle route assignment across a fleet.
- Live traffic-aware dynamic re-routing.
- Saved/named routes with user accounts.
- Public deployment with usage-based rate limiting.

---

## 6. Features & Functional Requirements

Priority key: **P0** = must-have for MVP, **P1** = should-have, **P2** = stretch/nice-to-have.

| ID | Priority | Feature | Description |
|---|---|---|---|
| F1 | P0 | Point-to-point routing | User submits origin + destination; system returns shortest path, distance, and estimated time. |
| F2 | P0 | Multi-stop optimization | User submits an origin plus a list of stops; system returns an optimized visiting order and total route. |
| F3 | P0 | Self-implemented pathfinding | Shortest-path computation uses custom Dijkstra and A* implementations, not a third-party directions API. |
| F4 | P0 | TSP heuristic optimization | Multi-stop ordering uses nearest-neighbor construction plus 2-opt local search improvement. |
| F5 | P0 | Async job processing | Optimization requests above a stop-count threshold are processed as background jobs with status polling. |
| F6 | P0 | Response caching | Identical or near-identical route requests are served from cache instead of recomputed. |
| F7 | P0 | Interactive map UI | Users can click to add stops, see the route drawn on a map, and view distance/time summary. |
| F8 | P1 | Naive vs. optimized comparison | UI shows the route as originally entered next to the optimized route, with distance/time saved. |
| F9 | P1 | Manual stop reordering | Users can drag-and-drop reorder stops and see the route update live. |
| F10 | P1 | Algorithm toggle | Users can switch between Dijkstra and A* for point-to-point queries and see relative performance. |
| F11 | P2 | Capacity-constrained routing | Support a basic vehicle capacity constraint (simplified VRP). |
| F12 | P2 | Time-window constraints | Support delivery time windows per stop. |
| F13 | P2 | Save/load routes | Persist named routes for later retrieval. |
| F14 | P2 | Export | Export a computed route as CSV or PDF. |

---

## 7. User Stories

1. **As a dispatcher**, I want to enter 15 delivery addresses and get back the shortest visiting order, so that my driver spends less time on the road.
2. **As a dispatcher**, I want to see how much distance the optimization saved compared to my original stop order, so that I can justify using the tool.
3. **As a driver**, I want the app to remain responsive while a large route is being computed, so that I'm not staring at a frozen screen.
4. **As a returning user**, I want a route I've already computed to load instantly, so that I don't wait on redundant computation.
5. **As a technical reviewer**, I want to see algorithm performance benchmarks (Dijkstra vs. A*, naive vs. 2-opt), so that I can evaluate the engineering quality of the project.

---

## 8. Success Metrics

| Metric | Target |
|---|---|
| Point-to-point route latency (p95) | < 300 ms (cache miss), < 50 ms (cache hit) |
| Multi-stop optimization (≤15 stops) | Synchronous response < 2 s |
| Multi-stop optimization (16–25 stops) | Async job completion < 10 s |
| Distance improvement vs. naive ordering | ≥ 10% average reduction on benchmark stop sets |
| Test coverage — algorithm modules | ≥ 80% |
| Uptime (local/demo deployment) | Best-effort; not a formal SLA for v1 |

---

## 9. Assumptions & Constraints

- Road network data is sourced once from OpenStreetMap (via Overpass API or a regional `.osm.pbf` extract) and pre-processed into the application database — it is **not** fetched live per request.
- The system covers a single bounded metro area for v1, not global routing.
- No live traffic data source; edge weights are static (distance/estimated speed by road class).
- Built and run by a single developer using free/open-source tooling — no paid mapping API is required for core routing.
- Target timeline: solo, part-time development over roughly 5–6 weeks.

---

## 10. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| 2-opt heuristic gives poor results at higher stop counts | Weak core differentiator | Benchmark against brute-force optimal for small N (≤10) to validate quality; cap MVP at 25 stops |
| OSM graph ingestion is more complex than expected | Timeline slip | Timebox to one mid-sized city extract; use existing OSM-to-graph tooling (e.g. `osmnx`-style preprocessing) rather than building a parser from scratch |
| Scope creep into VRP/fleet features | Reduced polish on core features | Freeze MVP scope at Section 6 P0 items; treat P1/P2 as stretch only after MVP is stable |
| Async job UX feels janky (long polling, no feedback) | Poor demo experience | Add explicit job status states (queued/processing/complete/failed) with progress indication in UI |

---

## 11. Milestones (indicative, solo/part-time)

| Week | Deliverable |
|---|---|
| 1 | Road graph ingestion pipeline; Dijkstra + A* implementations with unit tests |
| 2 | 2-opt TSP heuristic; Express API skeleton (routing endpoints) |
| 3 | Angular app shell, map integration, route input UI |
| 4 | Redis caching layer; BullMQ async job processing |
| 5 | Testing, CI/CD pipeline, Docker Compose, README + architecture docs |
| 6 | Polish, benchmark write-up, demo recording |

---

## 12. Appendix

- See **SRS.md** for detailed functional/non-functional requirements, API contracts, data model, and architecture.
- **Glossary**: TSP (Traveling Salesman Problem), VRP (Vehicle Routing Problem), 2-opt (a local-search improvement technique for tour optimization), PostGIS (geospatial extension for PostgreSQL).
