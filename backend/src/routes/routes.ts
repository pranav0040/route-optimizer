import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import {
  aStarShortestPath,
  dijkstraShortestPath,
  type ShortestPathResult
} from '../algorithms/pathfinding.js';
import {
  optimizeMultiStopRoute,
  type MultiStopRouteRequest,
  type OptimizedRoute,
  type RouteOptimizationError
} from '../algorithms/route-optimizer.js';
import { createRouteCacheKey } from '../cache/cache-key.js';
import type { RouteResponseCache } from '../cache/route-cache.js';
import { findNearestNode, getSnapRadiusM, type NearestNode } from '../db/nearest-node.js';
import { getRoadGraph, type RoadGraph } from '../graph/road-graph.js';
import { ApiError } from '../http/api-error.js';
import type { OptimizationJobQueue } from '../jobs/types.js';
import { optimizedRouteResponse, type OptimizeResponse } from './route-response.js';

const DEFAULT_SPEED_MPS = 13.89;
const SYNC_STOP_LIMIT = 15;

const coordinateSchema = z.object({
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180)
});

const pointToPointSchema = z.object({
  origin: coordinateSchema,
  destination: coordinateSchema,
  algorithm: z.enum(['dijkstra', 'astar'])
});

const optimizeSchema = z.object({
  origin: coordinateSchema,
  stops: z.array(coordinateSchema).min(2).max(25)
});

type Coordinate = z.infer<typeof coordinateSchema>;
type SnapCoordinate = (lat: number, lng: number) => Promise<NearestNode | null>;
type FindShortestPath = (
  startNodeId: number,
  endNodeId: number,
  graph: RoadGraph
) => ShortestPathResult | null;
type OptimizeRoute = (
  request: MultiStopRouteRequest,
  graph?: RoadGraph
) => OptimizedRoute | RouteOptimizationError;

interface PointToPointResponse {
  distance_m: number;
  duration_s: number;
  path: number[][];
  algorithm: 'dijkstra' | 'astar';
  cached: boolean;
}

export interface RouteRouterOptions {
  graph?: RoadGraph;
  snapCoordinate?: SnapCoordinate;
  cache?: RouteResponseCache;
  dijkstra?: FindShortestPath;
  aStar?: FindShortestPath;
  optimizeRoute?: OptimizeRoute;
  jobQueue?: OptimizationJobQueue;
}

export function createRouteRouter(options: RouteRouterOptions = {}) {
  const router = Router();
  const graph = () => options.graph ?? getRoadGraph();
  const snapCoordinate =
    options.snapCoordinate ??
    ((lat, lng) => {
      const roadGraph = graph();
      return findNearestNode(lat, lng, {
        acceptNode: (nodeId) => roadGraph.isRoutableNode(nodeId)
      });
    });
  const dijkstra = options.dijkstra ?? dijkstraShortestPath;
  const aStar = options.aStar ?? aStarShortestPath;
  const optimizeRoute = options.optimizeRoute ?? optimizeMultiStopRoute;

  router.get('/coverage', (_req, res) => {
    const roadGraph = graph();
    const bounds = roadGraph.routableBounds;

    if (!bounds) {
      throw new ApiError(
        503,
        'GRAPH_UNAVAILABLE',
        'Routable road-network coverage is unavailable.'
      );
    }

    res.json({
      bounds,
      snap_radius_m: getSnapRadiusM(),
      routable_node_count: roadGraph.routableNodeCount
    });
  });

  router.post(
    '/point-to-point',
    asyncHandler(async (req, res) => {
      const body = pointToPointSchema.parse(req.body);
      const cacheKey = createRouteCacheKey({ type: 'point-to-point', ...body });
      const cachedResponse = await options.cache?.get<PointToPointResponse>(cacheKey);

      if (cachedResponse) {
        res.json({ ...cachedResponse, cached: true });
        return;
      }

      const [originNode, destinationNode] = await Promise.all([
        snapOrThrow(body.origin, 'origin', snapCoordinate),
        snapOrThrow(body.destination, 'destination', snapCoordinate)
      ]);
      const findPath = body.algorithm === 'dijkstra' ? dijkstra : aStar;
      const result = findPath(originNode.id, destinationNode.id, graph());

      if (!result) {
        throw new ApiError(
          422,
          'ROUTE_NOT_FOUND',
          'No route exists between the snapped origin and destination.'
        );
      }

      const response = pointToPointResponse(result, body.algorithm);

      await options.cache?.set(cacheKey, response);
      res.json(response);
    })
  );

  router.post(
    '/optimize',
    asyncHandler(async (req, res) => {
      const body = optimizeSchema.parse(req.body);
      const cacheKey = createRouteCacheKey({
        type: 'optimize',
        origin: body.origin,
        stops: body.stops,
        algorithm: 'nearest-neighbor-2opt-astar'
      });
      const cachedResponse = await options.cache?.get<OptimizeResponse>(cacheKey);

      if (cachedResponse) {
        res.json({ ...cachedResponse, cached: true });
        return;
      }

      if (body.stops.length > SYNC_STOP_LIMIT) {
        if (!options.jobQueue) {
          throw new ApiError(503, 'JOB_QUEUE_UNAVAILABLE', 'Background job queue is unavailable.');
        }

        const jobId = await options.jobQueue.enqueue({
          origin: body.origin,
          stops: body.stops,
          cacheKey
        });

        res.status(202).json({ job_id: jobId, status: 'queued', cached: false });
        return;
      }

      const snappedCoordinates = await Promise.all([
        snapOrThrow(body.origin, 'origin', snapCoordinate),
        ...body.stops.map((stop, index) => snapOrThrow(stop, `stops[${index}]`, snapCoordinate))
      ]);
      const [originNode, ...stopNodes] = snappedCoordinates;

      let result: OptimizedRoute;

      try {
        const optimization = optimizeRoute(
          {
            originNodeId: originNode.id,
            stopNodeIds: stopNodes.map((node) => node.id)
          },
          graph()
        );

        if ('status' in optimization) {
          throw new ApiError(
            optimization.status,
            optimization.error.code,
            optimization.error.message
          );
        }

        result = optimization;
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith('No route found between graph nodes')
        ) {
          throw new ApiError(422, 'ROUTE_NOT_FOUND', 'At least one stop is unreachable.');
        }

        throw error;
      }

      const response = optimizedRouteResponse(result);

      await options.cache?.set(cacheKey, response);
      res.json(response);
    })
  );

  return router;
}

function pointToPointResponse(result: ShortestPathResult, algorithm: 'dijkstra' | 'astar') {
  return {
    distance_m: result.distanceM,
    duration_s: Math.round(result.distanceM / DEFAULT_SPEED_MPS),
    path: result.path.map(({ lat, lng }) => [lat, lng]),
    algorithm,
    cached: false
  };
}

async function snapOrThrow(coordinate: Coordinate, field: string, snapCoordinate: SnapCoordinate) {
  const node = await snapCoordinate(coordinate.lat, coordinate.lng);

  if (!node) {
    throw new ApiError(
      422,
      'SNAP_RADIUS_EXCEEDED',
      `${field} could not be matched to a road-network node within the snap radius.`
    );
  }

  return node;
}

function asyncHandler(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res, next).catch(next);
  };
}
