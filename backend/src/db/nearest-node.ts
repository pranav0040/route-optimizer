import { pool, type Queryable } from './pool.js';

export interface NearestNode {
  id: number;
  lat: number;
  lng: number;
  distanceM: number;
}

interface NearestNodeRow {
  id: string | number;
  lat: string | number;
  lng: string | number;
  distance_m: string | number;
}

export interface FindNearestNodeOptions {
  client?: Queryable;
  snapRadiusM?: number;
  candidateLimit?: number;
  acceptNode?: (nodeId: number) => boolean;
}

export const DEFAULT_SNAP_RADIUS_M = 500;
const DEFAULT_CANDIDATE_LIMIT = 256;

export async function findNearestNode(
  lat: number,
  lng: number,
  options: FindNearestNodeOptions = {}
): Promise<NearestNode | null> {
  assertCoordinate(lat, lng);

  const client = options.client ?? pool;
  const snapRadiusM = options.snapRadiusM ?? getSnapRadiusM();
  const candidateLimit = options.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT;

  if (!Number.isFinite(snapRadiusM) || snapRadiusM <= 0) {
    throw new RangeError('snapRadiusM must be a positive finite number');
  }

  if (!Number.isInteger(candidateLimit) || candidateLimit <= 0) {
    throw new RangeError('candidateLimit must be a positive integer');
  }

  const result = await client.query<NearestNodeRow>(
    `
      WITH query_point AS (
        SELECT ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography AS geom
      )
      SELECT
        nodes.id,
        nodes.lat,
        nodes.lng,
        ST_Distance(nodes.geom, query_point.geom) AS distance_m
      FROM nodes, query_point
      WHERE ST_DWithin(nodes.geom, query_point.geom, $3)
      ORDER BY nodes.geom <-> query_point.geom
      LIMIT $4
    `,
    [lat, lng, snapRadiusM, candidateLimit]
  );

  const row = result.rows.find((candidate) => options.acceptNode?.(Number(candidate.id)) ?? true);

  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    lat: Number(row.lat),
    lng: Number(row.lng),
    distanceM: Number(row.distance_m)
  };
}

export function getSnapRadiusM() {
  const rawValue = process.env.SNAP_RADIUS_M;

  if (!rawValue) {
    return DEFAULT_SNAP_RADIUS_M;
  }

  const value = Number(rawValue);

  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError('SNAP_RADIUS_M must be a positive finite number');
  }

  return value;
}

function assertCoordinate(lat: number, lng: number) {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new RangeError('lat must be a finite number between -90 and 90');
  }

  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new RangeError('lng must be a finite number between -180 and 180');
  }
}
