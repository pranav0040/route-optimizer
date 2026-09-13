import { createHash } from 'node:crypto';

const CACHE_KEY_VERSION = 'v1';
const COORDINATE_PRECISION = 5;

export interface CacheCoordinate {
  lat: number;
  lng: number;
}

export type RouteCacheKeyInput =
  | {
      type: 'point-to-point';
      origin: CacheCoordinate;
      destination: CacheCoordinate;
      algorithm: 'dijkstra' | 'astar';
    }
  | {
      type: 'optimize';
      origin: CacheCoordinate;
      stops: CacheCoordinate[];
      algorithm: 'nearest-neighbor-2opt-astar';
    };

export function createRouteCacheKey(input: RouteCacheKeyInput) {
  const normalized =
    input.type === 'point-to-point'
      ? {
          type: input.type,
          origin: normalizeCoordinate(input.origin),
          destination: normalizeCoordinate(input.destination),
          algorithm: input.algorithm
        }
      : {
          type: input.type,
          origin: normalizeCoordinate(input.origin),
          stops: input.stops.map(normalizeCoordinate),
          algorithm: input.algorithm
        };
  const digest = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');

  return `route-cache:${CACHE_KEY_VERSION}:${digest}`;
}

function normalizeCoordinate(coordinate: CacheCoordinate) {
  return {
    lat: normalizeNumber(coordinate.lat),
    lng: normalizeNumber(coordinate.lng)
  };
}

function normalizeNumber(value: number) {
  const rounded = Number(value.toFixed(COORDINATE_PRECISION));

  return Object.is(rounded, -0) ? 0 : rounded;
}
