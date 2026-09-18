import { describe, expect, it } from 'vitest';

import { findNearestNode } from '../src/db/nearest-node.js';
import type { Queryable } from '../src/db/pool.js';

interface SeedNode {
  id: number;
  lat: number;
  lng: number;
}

class SeededNodeClient implements Queryable {
  public readonly calls: Array<unknown[]> = [];

  constructor(private readonly nodes: SeedNode[]) {}

  async query(_sql: string, params?: unknown[]) {
    this.calls.push(params ?? []);

    const [lat, lng, snapRadiusM, candidateLimit] = params as [number, number, number, number];
    const rows = this.nodes
      .map((node) => ({
        id: node.id,
        lat: node.lat,
        lng: node.lng,
        distance_m: haversineDistanceM({ lat, lng }, node)
      }))
      .filter((row) => row.distance_m <= snapRadiusM)
      .sort((a, b) => a.distance_m - b.distance_m)
      .slice(0, candidateLimit);

    return { rows };
  }
}

describe('findNearestNode', () => {
  const seededNodes: SeedNode[] = [
    { id: 101, lat: 43.0731, lng: -89.4012 },
    { id: 102, lat: 43.074, lng: -89.381 },
    { id: 103, lat: 43.083, lng: -89.39 }
  ];

  it('returns the closest seeded node inside the default snap radius', async () => {
    const client = new SeededNodeClient(seededNodes);

    const nearest = await findNearestNode(43.07312, -89.40118, { client });

    expect(nearest).toMatchObject({
      id: 101,
      lat: 43.0731,
      lng: -89.4012
    });
    expect(nearest?.distanceM).toBeLessThan(5);
    expect(client.calls[0]).toEqual([43.07312, -89.40118, 500, 256]);
  });

  it('returns null when no seeded node is inside the snap radius', async () => {
    const client = new SeededNodeClient(seededNodes);

    const nearest = await findNearestNode(43.2, -89.6, { client, snapRadiusM: 100 });

    expect(nearest).toBeNull();
    expect(client.calls[0]).toEqual([43.2, -89.6, 100, 256]);
  });

  it('skips a closer disconnected candidate in favor of a routable node', async () => {
    const client = new SeededNodeClient(seededNodes);

    const nearest = await findNearestNode(43.07312, -89.40118, {
      client,
      snapRadiusM: 3_000,
      acceptNode: (nodeId) => nodeId !== 101
    });

    expect(nearest?.id).toBe(102);
  });

  it('rejects invalid coordinates before querying the database', async () => {
    const client = new SeededNodeClient(seededNodes);

    await expect(findNearestNode(120, -89.4, { client })).rejects.toThrow(RangeError);
    expect(client.calls).toHaveLength(0);
  });
});

function haversineDistanceM(from: { lat: number; lng: number }, to: { lat: number; lng: number }) {
  const earthRadiusM = 6_371_000;
  const dLat = toRadians(to.lat - from.lat);
  const dLng = toRadians(to.lng - from.lng);
  const lat1 = toRadians(from.lat);
  const lat2 = toRadians(to.lat);

  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * earthRadiusM * Math.asin(Math.sqrt(a));
}

function toRadians(degrees: number) {
  return (degrees * Math.PI) / 180;
}
