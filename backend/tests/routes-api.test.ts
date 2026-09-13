import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { NearestNode } from '../src/db/nearest-node.js';
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
