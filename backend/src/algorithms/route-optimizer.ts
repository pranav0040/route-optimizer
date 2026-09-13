import { performance } from 'node:perf_hooks';

import { aStarShortestPath, type RouteCoordinate, type ShortestPathResult } from './pathfinding.js';
import { getRoadGraph, type RoadGraph } from '../graph/road-graph.js';

const MIN_STOPS = 2;
const MAX_STOPS = 25;
const TWO_OPT_TIME_BUDGET_MS = 500;
const DEFAULT_SPEED_MPS = 13.89;
const ORIGIN_INDEX = -1;

export interface MultiStopRouteRequest {
  originNodeId: number;
  stopNodeIds: number[];
}

export interface OptimizedRoute {
  optimizedOrder: number[];
  optimizedPath: RouteCoordinate[];
  totalDistanceM: number;
  totalDurationS: number;
  naivePath: RouteCoordinate[];
  naiveDistanceM: number;
  naiveDurationS: number;
}

export interface RouteOptimizationError {
  status: 400;
  error: {
    code: string;
    message: string;
    details: {
      minStops: number;
      maxStops: number;
      receivedStops: number;
    };
  };
}

type FindShortestPath = (
  startNodeId: number,
  endNodeId: number,
  graph: RoadGraph
) => ShortestPathResult | null;

type PairwiseRouteCache = Map<string, ShortestPathResult>;

/**
 * Nearest-neighbor construction is O(n^2) pair selections for n stops; each
 * uncached pair delegates to A* over the road graph. 2-opt checks O(n^2) swaps
 * per pass and is bounded by a 500 ms wall-clock budget for responsiveness.
 */
export function optimizeMultiStopRoute(
  request: MultiStopRouteRequest,
  graph?: RoadGraph,
  findShortestPath: FindShortestPath = aStarShortestPath
): OptimizedRoute | RouteOptimizationError {
  const validationError = validateStopCount(request.stopNodeIds.length);

  if (validationError) {
    return validationError;
  }

  const routeGraph = graph ?? getRoadGraph();
  const routeCache: PairwiseRouteCache = new Map();
  const routeBetweenStops = (fromIndex: number, toIndex: number) =>
    getPairwiseRoute(fromIndex, toIndex, request, routeGraph, findShortestPath, routeCache);
  const distanceBetweenStops = (fromIndex: number, toIndex: number) =>
    routeBetweenStops(fromIndex, toIndex).distanceM;

  const naiveOrder = request.stopNodeIds.map((_nodeId, index) => index);
  const naiveDistanceM = routeDistanceM(naiveOrder, distanceBetweenStops);
  const initialOrder = buildNearestNeighborOrder(request.stopNodeIds.length, distanceBetweenStops);
  const optimizedOrder = improveWithTwoOpt(initialOrder, distanceBetweenStops);
  const totalDistanceM = routeDistanceM(optimizedOrder, distanceBetweenStops);

  return {
    optimizedOrder,
    optimizedPath: routePath(optimizedOrder, routeBetweenStops),
    totalDistanceM,
    totalDurationS: estimateDurationS(totalDistanceM),
    naivePath: routePath(naiveOrder, routeBetweenStops),
    naiveDistanceM,
    naiveDurationS: estimateDurationS(naiveDistanceM)
  };
}

export function validateStopCount(stopCount: number): RouteOptimizationError | null {
  if (stopCount >= MIN_STOPS && stopCount <= MAX_STOPS) {
    return null;
  }

  return {
    status: 400,
    error: {
      code: 'STOP_LIMIT_OUT_OF_RANGE',
      message: `Multi-stop optimization supports ${MIN_STOPS}-${MAX_STOPS} stops; received ${stopCount}.`,
      details: {
        minStops: MIN_STOPS,
        maxStops: MAX_STOPS,
        receivedStops: stopCount
      }
    }
  };
}

function buildNearestNeighborOrder(
  stopCount: number,
  distanceBetweenStops: (fromIndex: number, toIndex: number) => number
) {
  const unvisited = new Set<number>();

  for (let index = 0; index < stopCount; index += 1) {
    unvisited.add(index);
  }

  const order: number[] = [];
  let currentIndex = ORIGIN_INDEX;

  while (unvisited.size > 0) {
    let nearestIndex: number | null = null;
    let nearestDistanceM = Number.POSITIVE_INFINITY;

    for (const candidateIndex of unvisited) {
      const candidateDistanceM = distanceBetweenStops(currentIndex, candidateIndex);

      if (
        candidateDistanceM < nearestDistanceM ||
        (candidateDistanceM === nearestDistanceM &&
          (nearestIndex === null || candidateIndex < nearestIndex))
      ) {
        nearestIndex = candidateIndex;
        nearestDistanceM = candidateDistanceM;
      }
    }

    if (nearestIndex === null) {
      break;
    }

    order.push(nearestIndex);
    unvisited.delete(nearestIndex);
    currentIndex = nearestIndex;
  }

  return order;
}

function improveWithTwoOpt(
  initialOrder: number[],
  distanceBetweenStops: (fromIndex: number, toIndex: number) => number
) {
  const deadline = performance.now() + TWO_OPT_TIME_BUDGET_MS;
  let bestOrder = [...initialOrder];
  let bestDistanceM = routeDistanceM(bestOrder, distanceBetweenStops);
  let improved = true;

  while (improved && performance.now() < deadline) {
    improved = false;

    for (let start = 0; start < bestOrder.length - 1; start += 1) {
      for (let end = start + 1; end < bestOrder.length; end += 1) {
        if (performance.now() >= deadline) {
          return bestOrder;
        }

        const candidateOrder = twoOptSwap(bestOrder, start, end);
        const candidateDistanceM = routeDistanceM(candidateOrder, distanceBetweenStops);

        if (candidateDistanceM < bestDistanceM) {
          bestOrder = candidateOrder;
          bestDistanceM = candidateDistanceM;
          improved = true;
        }
      }
    }
  }

  return bestOrder;
}

function twoOptSwap(order: number[], start: number, end: number) {
  return [
    ...order.slice(0, start),
    ...order.slice(start, end + 1).reverse(),
    ...order.slice(end + 1)
  ];
}

function routeDistanceM(
  order: number[],
  distanceBetweenStops: (fromIndex: number, toIndex: number) => number
) {
  let distanceM = 0;
  let fromIndex = ORIGIN_INDEX;

  for (const toIndex of order) {
    distanceM += distanceBetweenStops(fromIndex, toIndex);
    fromIndex = toIndex;
  }

  return distanceM;
}

function getPairwiseRoute(
  fromIndex: number,
  toIndex: number,
  request: MultiStopRouteRequest,
  graph: RoadGraph,
  findShortestPath: FindShortestPath,
  routeCache: PairwiseRouteCache
) {
  const fromNodeId = nodeIdForIndex(fromIndex, request);
  const toNodeId = nodeIdForIndex(toIndex, request);
  const cacheKey = `${fromNodeId}->${toNodeId}`;
  const cachedRoute = routeCache.get(cacheKey);

  if (cachedRoute) {
    return cachedRoute;
  }

  const shortestPath = findShortestPath(fromNodeId, toNodeId, graph);

  if (!shortestPath) {
    throw new Error(`No route found between graph nodes ${fromNodeId} and ${toNodeId}`);
  }

  routeCache.set(cacheKey, shortestPath);
  return shortestPath;
}

function routePath(
  order: number[],
  routeBetweenStops: (fromIndex: number, toIndex: number) => ShortestPathResult
) {
  const path: RouteCoordinate[] = [];
  let fromIndex = ORIGIN_INDEX;

  for (const toIndex of order) {
    const legPath = routeBetweenStops(fromIndex, toIndex).path;

    path.push(...(path.length === 0 ? legPath : legPath.slice(1)));
    fromIndex = toIndex;
  }

  return path;
}

function nodeIdForIndex(index: number, request: MultiStopRouteRequest) {
  return index === ORIGIN_INDEX ? request.originNodeId : request.stopNodeIds[index];
}

function estimateDurationS(distanceM: number) {
  return Math.round(distanceM / DEFAULT_SPEED_MPS);
}
