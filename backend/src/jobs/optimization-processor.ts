import {
  optimizeMultiStopRoute,
  type MultiStopRouteRequest,
  type OptimizedRoute,
  type RouteOptimizationError
} from '../algorithms/route-optimizer.js';
import { findNearestNode, type NearestNode } from '../db/nearest-node.js';
import type { RoadGraph } from '../graph/road-graph.js';
import type { RouteResponseCache } from '../cache/route-cache.js';
import { optimizedRouteResponse } from '../routes/route-response.js';
import type { JobRepository, JobStatusPublisher, OptimizationJobData } from './types.js';

type SnapCoordinate = (lat: number, lng: number) => Promise<NearestNode | null>;
type OptimizeRoute = (
  request: MultiStopRouteRequest,
  graph?: RoadGraph
) => OptimizedRoute | RouteOptimizationError;

export interface OptimizationProcessorDependencies {
  graph: RoadGraph;
  repository: JobRepository;
  publisher: JobStatusPublisher;
  cache?: RouteResponseCache;
  snapCoordinate?: SnapCoordinate;
  optimizeRoute?: OptimizeRoute;
}

export async function processOptimizationJob(
  jobId: string,
  data: OptimizationJobData,
  dependencies: OptimizationProcessorDependencies
) {
  const snapCoordinate =
    dependencies.snapCoordinate ??
    ((lat, lng) =>
      findNearestNode(lat, lng, {
        acceptNode: (nodeId) => dependencies.graph.isRoutableNode(nodeId)
      }));
  const optimizeRoute = dependencies.optimizeRoute ?? optimizeMultiStopRoute;

  await dependencies.repository.markProcessing(jobId);
  await safePublish(dependencies.publisher, {
    jobId,
    status: 'processing',
    routeId: null,
    errorReason: null
  });

  const snapped = await Promise.all([
    snapOrThrow(data.origin, 'origin', snapCoordinate),
    ...data.stops.map((stop, index) => snapOrThrow(stop, `stops[${index}]`, snapCoordinate))
  ]);
  const [origin, ...stops] = snapped;
  const optimization = optimizeRoute(
    {
      originNodeId: origin.id,
      stopNodeIds: stops.map((stop) => stop.id)
    },
    dependencies.graph
  );

  if ('status' in optimization) {
    throw new Error(optimization.error.message);
  }

  const routeId = await dependencies.repository.completeJob(jobId, data, optimization);

  await dependencies.cache?.set(data.cacheKey, optimizedRouteResponse(optimization));

  await safePublish(dependencies.publisher, {
    jobId,
    status: 'completed',
    routeId,
    errorReason: null
  });

  return { routeId, result: optimization };
}

async function safePublish(
  publisher: JobStatusPublisher,
  event: Parameters<JobStatusPublisher['publish']>[0]
) {
  try {
    await publisher.publish(event);
  } catch (error) {
    console.error('Could not publish job-status event.', error);
  }
}

async function snapOrThrow(
  coordinate: { lat: number; lng: number },
  field: string,
  snapCoordinate: SnapCoordinate
) {
  const node = await snapCoordinate(coordinate.lat, coordinate.lng);

  if (!node) {
    throw new Error(`${field} could not be matched within the configured snap radius.`);
  }

  return node;
}
