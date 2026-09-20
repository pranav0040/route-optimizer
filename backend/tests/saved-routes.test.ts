import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { RouteRepository, StoredRoute } from '../src/db/route-repository.js';

const routeId = '11111111-1111-4111-8111-111111111111';
const storedRoute: StoredRoute = {
  id: routeId,
  origin: { lat: 12.9716, lng: 77.5946 },
  stops: [
    { lat: 12.9611, lng: 77.6387 },
    { lat: 12.9352, lng: 77.6146 }
  ],
  optimizedOrder: [1, 0],
  optimizedPath: [
    [12.9716, 77.5946],
    [12.9352, 77.6146],
    [12.9611, 77.6387]
  ],
  totalDistanceM: 11_150,
  totalDurationS: 803,
  naivePath: [
    [12.9716, 77.5946],
    [12.9611, 77.6387],
    [12.9352, 77.6146]
  ],
  naiveDistanceM: 12_080,
  naiveDurationS: 870,
  improvementPct: 7.7,
  createdAt: '2026-09-21T00:00:00.000Z'
};

describe('GET /api/routes/:id', () => {
  it('returns a persisted optimized route', async () => {
    const app = createApp({ routeRepository: new MemoryRouteRepository(storedRoute) });
    const response = await request(app).get(`/api/routes/${routeId}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      route_id: routeId,
      origin: storedRoute.origin,
      stops: storedRoute.stops,
      optimized_order: storedRoute.optimizedOrder,
      optimized_path: storedRoute.optimizedPath,
      total_distance_m: 11_150,
      total_duration_s: 803,
      naive_path: storedRoute.naivePath,
      naive_distance_m: 12_080,
      naive_duration_s: 870,
      improvement_pct: 7.7,
      created_at: storedRoute.createdAt,
      cached: true
    });
  });

  it('returns 404 for an unknown route ID', async () => {
    const app = createApp({ routeRepository: new MemoryRouteRepository(null) });
    const response = await request(app).get(`/api/routes/${routeId}`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('ROUTE_NOT_FOUND');
  });

  it('rejects an invalid route ID', async () => {
    const app = createApp({ routeRepository: new MemoryRouteRepository(storedRoute) });
    const response = await request(app).get('/api/routes/not-a-route-id');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});

class MemoryRouteRepository implements RouteRepository {
  constructor(private readonly route: StoredRoute | null) {}

  async getRoute(routeIdToFind: string) {
    return this.route?.id === routeIdToFind ? this.route : null;
  }
}
