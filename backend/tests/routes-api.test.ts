import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { NearestNode } from '../src/db/nearest-node.js';
import type { Geocoder } from '../src/geocoding/geocoder.js';
import { type GraphEdge, type GraphNode, RoadGraph } from '../src/graph/road-graph.js';

const graph = new RoadGraph(
  [node(1, 0), node(2, 0.001), node(3, 0.002), node(4, 0.003)],
  [
    edge(1, 2, 100),
    edge(1, 3, 300),
    edge(1, 4, 500),
    edge(2, 1, 100),
    edge(2, 3, 100),
    edge(2, 4, 300),
    edge(3, 1, 300),
    edge(3, 2, 100),
    edge(3, 4, 100),
    edge(4, 1, 500),
    edge(4, 2, 300),
    edge(4, 3, 100)
  ]
);

const app = createApp({
  graph,
  snapCoordinate,
  jobQueue: {
    async enqueue() {
      return '11111111-1111-4111-8111-111111111111';
    }
  }
});

describe('GET /api/routes/coverage', () => {
  it('returns the strongly connected graph bounds and configured snap radius', async () => {
    const response = await request(app).get('/api/routes/coverage');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      bounds: { south: 0, west: 0, north: 0.003, east: 0 },
      snap_radius_m: 500,
      routable_node_count: 4
    });
  });
});

describe('GET /api/geocoding/search', () => {
  it('returns the coordinate and display name for an address', async () => {
    const geocoder: Geocoder = {
      async geocode() {
        return {
          lat: 12.976347,
          lng: 77.592928,
          displayName: 'Cubbon Park, Bengaluru, Karnataka, India',
          cached: false
        };
      },
      async search() {
        return [];
      },
      async reverse() {
        return null;
      }
    };
    const response = await request(createApp({ geocoder }))
      .get('/api/geocoding/search')
      .query({ address: 'Cubbon Park' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      lat: 12.976347,
      lng: 77.592928,
      display_name: 'Cubbon Park, Bengaluru, Karnataka, India',
      cached: false
    });
  });

  it('returns 422 when an address has no match', async () => {
    const geocoder: Geocoder = {
      geocode: async () => null,
      search: async () => [],
      reverse: async () => null
    };
    const response = await request(createApp({ geocoder }))
      .get('/api/geocoding/search')
      .query({ address: 'Unknown place' });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('ADDRESS_NOT_FOUND');
  });

  it('returns multiple selectable suggestions for an address query', async () => {
    const geocoder: Geocoder = {
      geocode: async () => null,
      reverse: async () => null,
      async search(_address, limit) {
        expect(limit).toBe(5);
        return [
          {
            lat: 12.976347,
            lng: 77.592928,
            displayName: 'Cubbon Park, Bengaluru, Karnataka, India',
            cached: false
          },
          {
            lat: 12.9751,
            lng: 77.5931,
            displayName: 'Cubbon Park Metro Station, Bengaluru, Karnataka, India',
            cached: false
          }
        ];
      }
    };
    const response = await request(createApp({ geocoder }))
      .get('/api/geocoding/suggestions')
      .query({ address: 'Cubbon Park' });

    expect(response.status).toBe(200);
    expect(response.body.suggestions).toHaveLength(2);
    expect(response.body.suggestions[0]).toEqual({
      lat: 12.976347,
      lng: 77.592928,
      display_name: 'Cubbon Park, Bengaluru, Karnataka, India',
      cached: false
    });
  });

  it('returns an address for a selected map coordinate', async () => {
    const geocoder: Geocoder = {
      geocode: async () => null,
      search: async () => [],
      async reverse(lat, lng) {
        expect({ lat, lng }).toEqual({ lat: 12.976347, lng: 77.592928 });
        return {
          lat,
          lng,
          displayName: 'Cubbon Park, Bengaluru, Karnataka, India',
          cached: false
        };
      }
    };
    const response = await request(createApp({ geocoder }))
      .get('/api/geocoding/reverse')
      .query({ lat: 12.976347, lng: 77.592928 });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      lat: 12.976347,
      lng: 77.592928,
      display_name: 'Cubbon Park, Bengaluru, Karnataka, India',
      cached: false
    });
  });
});

describe('POST /api/routes/point-to-point', () => {
  it.each(['dijkstra', 'astar'] as const)(
    'returns an SRS 8.1 response for a valid %s request',
    async (algorithm) => {
      const response = await request(app)
        .post('/api/routes/point-to-point')
        .send({
          origin: { lat: 0, lng: 0 },
          destination: { lat: 0.002, lng: 0 },
          algorithm
        });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        distance_m: 200,
        duration_s: 14,
        path: [
          [0, 0],
          [0.001, 0],
          [0.002, 0]
        ],
        algorithm,
        cached: false
      });
    }
  );

  it('returns the centralized validation error when a required field is missing', async () => {
    const response = await request(app)
      .post('/api/routes/point-to-point')
      .send({
        origin: { lat: 0, lng: 0 },
        algorithm: 'astar'
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.message).toContain('destination');
  });

  it('returns the centralized validation error for malformed JSON', async () => {
    const response = await request(app)
      .post('/api/routes/point-to-point')
      .set('Content-Type', 'application/json')
      .send('{');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request body must contain valid JSON.'
      }
    });
  });

  it('returns 422 when a coordinate cannot be snapped', async () => {
    const response = await request(app)
      .post('/api/routes/point-to-point')
      .send({
        origin: { lat: 50, lng: 50 },
        destination: { lat: 0.002, lng: 0 },
        algorithm: 'astar'
      });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      error: {
        code: 'SNAP_RADIUS_EXCEEDED',
        message: 'origin could not be matched to a road-network node within the snap radius.'
      }
    });
  });
});

describe('POST /api/routes/optimize', () => {
  it('returns an SRS 8.2 synchronous response for 2-15 stops', async () => {
    const response = await request(app)
      .post('/api/routes/optimize')
      .send({
        origin: { lat: 0, lng: 0 },
        stops: [
          { lat: 0.002, lng: 0 },
          { lat: 0.001, lng: 0 }
        ]
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      optimized_order: [1, 0],
      optimized_path: [
        [0, 0],
        [0.001, 0],
        [0.002, 0]
      ],
      total_distance_m: 200,
      total_duration_s: 14,
      naive_path: [
        [0, 0],
        [0.001, 0],
        [0.002, 0],
        [0.001, 0]
      ],
      naive_distance_m: 300,
      naive_duration_s: 22,
      improvement_pct: 33.3,
      cached: false
    });
  });

  it('returns 202 and a queued job shape for 16-25 stops', async () => {
    const response = await request(app)
      .post('/api/routes/optimize')
      .send({
        origin: { lat: 0, lng: 0 },
        stops: Array.from({ length: 16 }, () => ({ lat: 0.001, lng: 0 }))
      });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      job_id: expect.any(String),
      status: 'queued',
      cached: false
    });
  });

  it('returns the centralized validation error when stops is missing', async () => {
    const response = await request(app)
      .post('/api/routes/optimize')
      .send({
        origin: { lat: 0, lng: 0 }
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.message).toContain('stops');
  });

  it.each([1, 26])('rejects a stop count of %s', async (stopCount) => {
    const response = await request(app)
      .post('/api/routes/optimize')
      .send({
        origin: { lat: 0, lng: 0 },
        stops: Array.from({ length: stopCount }, () => ({ lat: 0.001, lng: 0 }))
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.message).toContain('stops');
  });

  it('returns 422 when any stop cannot be snapped', async () => {
    const response = await request(app)
      .post('/api/routes/optimize')
      .send({
        origin: { lat: 0, lng: 0 },
        stops: [
          { lat: 0.001, lng: 0 },
          { lat: 50, lng: 50 }
        ]
      });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('SNAP_RADIUS_EXCEEDED');
    expect(response.body.error.message).toContain('stops[1]');
  });
});

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
