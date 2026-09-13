import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { dijkstraShortestPath } from '../src/algorithms/pathfinding.js';
import { optimizeMultiStopRoute } from '../src/algorithms/route-optimizer.js';
import { createApp } from '../src/app.js';
import { createRouteCacheKey } from '../src/cache/cache-key.js';
import { RedisRouteResponseCache, type CacheClient } from '../src/cache/route-cache.js';
import type { NearestNode } from '../src/db/nearest-node.js';
import { type GraphEdge, type GraphNode, RoadGraph } from '../src/graph/road-graph.js';

describe('route response caching', () => {
  it('normalizes coordinate precision but preserves meaningful stop ordering', () => {
    const first = createRouteCacheKey({
      type: 'optimize',
      origin: { lat: 12.9716001, lng: 77.5946001 },
      stops: [
        { lat: 12.9611001, lng: 77.6387001 },
        { lat: 12.9352001, lng: 77.6146001 }
      ],
      algorithm: 'nearest-neighbor-2opt-astar'
    });
    const equivalentPrecision = createRouteCacheKey({
      type: 'optimize',
      origin: { lat: 12.9716002, lng: 77.5946002 },
      stops: [
        { lat: 12.9611002, lng: 77.6387002 },
        { lat: 12.9352002, lng: 77.6146002 }
      ],
      algorithm: 'nearest-neighbor-2opt-astar'
    });
    const reordered = createRouteCacheKey({
      type: 'optimize',
      origin: { lat: 12.9716002, lng: 77.5946002 },
      stops: [
        { lat: 12.9352002, lng: 77.6146002 },
        { lat: 12.9611002, lng: 77.6387002 }
      ],
      algorithm: 'nearest-neighbor-2opt-astar'
    });

    expect(equivalentPrecision).toBe(first);
    expect(reordered).not.toBe(first);
    expect(first).toMatch(/^route-cache:v1:[a-f0-9]{64}$/);
  });

  it('bypasses point-to-point pathfinding on an identical second request', async () => {
    const dijkstra = vi.fn(dijkstraShortestPath);
    const app = cachedApp({ dijkstra });
    const body = {
      origin: { lat: 0, lng: 0 },
      destination: { lat: 0.002, lng: 0 },
      algorithm: 'dijkstra'
    };

    const first = await request(app).post('/api/routes/point-to-point').send(body);
    const second = await request(app).post('/api/routes/point-to-point').send(body);

    expect(first.status).toBe(200);
    expect(first.body.cached).toBe(false);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ...first.body, cached: true });
    expect(dijkstra).toHaveBeenCalledTimes(1);
  });

  it('bypasses multi-stop optimization on an identical second request', async () => {
    const optimizeRoute = vi.fn(optimizeMultiStopRoute);
    const app = cachedApp({ optimizeRoute });
    const body = {
      origin: { lat: 0, lng: 0 },
      stops: [
        { lat: 0.002, lng: 0 },
        { lat: 0.001, lng: 0 }
      ]
    };

    const first = await request(app).post('/api/routes/optimize').send(body);
    const second = await request(app).post('/api/routes/optimize').send(body);

    expect(first.status).toBe(200);
    expect(first.body.cached).toBe(false);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ...first.body, cached: true });
    expect(optimizeRoute).toHaveBeenCalledTimes(1);
  });

  it('returns a completed cached result instead of enqueueing another large job', async () => {
    const cache = new RedisRouteResponseCache(new MemoryCacheClient(() => Date.now()), 60);
    const enqueue = vi.fn(async () => 'unused-job-id');
    const body = {
      origin: { lat: 0, lng: 0 },
      stops: Array.from({ length: 16 }, () => ({ lat: 0.001, lng: 0 }))
    };
    const cacheKey = createRouteCacheKey({
      type: 'optimize',
      ...body,
      algorithm: 'nearest-neighbor-2opt-astar'
    });

    await cache.set(cacheKey, {
      optimized_order: Array.from({ length: 16 }, (_value, index) => index),
      optimized_path: [
        [0, 0],
        [0.001, 0]
      ],
      total_distance_m: 100,
      total_duration_s: 7,
      naive_path: [
        [0, 0],
        [0.001, 0]
      ],
      naive_distance_m: 100,
      naive_duration_s: 7,
      improvement_pct: 0,
      cached: false
    });
    const app = createApp({ graph, snapCoordinate, cache, jobQueue: { enqueue } });
    const response = await request(app).post('/api/routes/optimize').send(body);

    expect(response.status).toBe(200);
    expect(response.body.cached).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('recomputes after the configured cache TTL expires', async () => {
    let nowMs = 0;
    const dijkstra = vi.fn(dijkstraShortestPath);
    const cache = new RedisRouteResponseCache(new MemoryCacheClient(() => nowMs), 1);
    const app = createApp({ graph, snapCoordinate, cache, dijkstra });
    const body = {
      origin: { lat: 0, lng: 0 },
      destination: { lat: 0.002, lng: 0 },
      algorithm: 'dijkstra'
    };

    await request(app).post('/api/routes/point-to-point').send(body);
    await request(app).post('/api/routes/point-to-point').send(body);
    nowMs = 1_001;
    const afterExpiry = await request(app).post('/api/routes/point-to-point').send(body);

    expect(afterExpiry.status).toBe(200);
    expect(afterExpiry.body.cached).toBe(false);
    expect(dijkstra).toHaveBeenCalledTimes(2);
  });
});

const graph = new RoadGraph(
  [node(1, 0), node(2, 0.001), node(3, 0.002)],
  [
    edge(1, 2, 100),
    edge(1, 3, 300),
    edge(2, 1, 100),
    edge(2, 3, 100),
    edge(3, 1, 300),
    edge(3, 2, 100)
  ]
);

function cachedApp(
  algorithms: Pick<Parameters<typeof createApp>[0], 'dijkstra' | 'optimizeRoute'>
) {
  return createApp({
    graph,
    snapCoordinate,
    cache: new RedisRouteResponseCache(new MemoryCacheClient(() => Date.now()), 60),
    ...algorithms
  });
}

class MemoryCacheClient implements CacheClient {
  private readonly entries = new Map<string, { value: string; expiresAtMs: number }>();

  constructor(private readonly now: () => number) {}

  async get(key: string) {
    const entry = this.entries.get(key);

    if (!entry || entry.expiresAtMs <= this.now()) {
      this.entries.delete(key);
      return null;
    }

    return entry.value;
  }

  async setex(key: string, ttlSeconds: number, value: string) {
    this.entries.set(key, {
      value,
      expiresAtMs: this.now() + ttlSeconds * 1_000
    });
  }
}

async function snapCoordinate(lat: number, lng: number): Promise<NearestNode | null> {
  const matchingNode = graph
    .getNodeIds()
    .map((id) => graph.getNode(id))
    .find((candidate) => candidate?.lat === lat && candidate.lng === lng);

  return matchingNode ? { ...matchingNode, distanceM: 0 } : null;
}

function node(id: number, lat: number): GraphNode {
  return { id, lat, lng: 0 };
}

function edge(fromNodeId: number, toNodeId: number, distanceM: number): GraphEdge {
  return { fromNodeId, toNodeId, distanceM };
}
