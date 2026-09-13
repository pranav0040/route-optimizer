import { describe, expect, it } from 'vitest';

import { dijkstraShortestPath } from '../src/algorithms/pathfinding.js';
import {
  optimizeMultiStopRoute,
  validateStopCount,
  type OptimizedRoute
} from '../src/algorithms/route-optimizer.js';
import { type GraphEdge, type GraphNode, RoadGraph } from '../src/graph/road-graph.js';

describe('multi-stop route optimizer', () => {
  it.each([1, 26])('returns a 400-shaped error for %s stops', (stopCount) => {
    const error = validateStopCount(stopCount);

    expect(error).toEqual({
      status: 400,
      error: {
        code: 'STOP_LIMIT_OUT_OF_RANGE',
        message: `Multi-stop optimization supports 2-25 stops; received ${stopCount}.`,
        details: {
          minStops: 2,
          maxStops: 25,
          receivedStops: stopCount
        }
      }
    });
  });

  it('returns optimized and naive route totals with stop indices in visiting order', () => {
    const graph = new RoadGraph(
      [node(1), node(2), node(3), node(4)],
      [
        edge(1, 2, 10),
        edge(1, 3, 1),
        edge(1, 4, 100),
        edge(2, 3, 1),
        edge(2, 4, 1),
        edge(3, 2, 1),
        edge(3, 4, 10),
        edge(4, 2, 1),
        edge(4, 3, 10)
      ]
    );

    const result = asRoute(
      optimizeMultiStopRoute(
        {
          originNodeId: 1,
          stopNodeIds: [2, 3, 4]
        },
        graph,
        dijkstraShortestPath
      )
    );

    expect(result.optimizedOrder).toEqual([1, 0, 2]);
    expect(result.optimizedPath.length).toBeGreaterThan(0);
    expect(result.totalDistanceM).toBe(3);
    expect(result.totalDurationS).toBe(0);
    expect(result.naiveDistanceM).toBe(5);
    expect(result.naiveDurationS).toBe(0);
    expect(result.naivePath.length).toBeGreaterThan(0);
  });

  it('caches pairwise shortest-path distances within a single optimization request', () => {
    const graph = new RoadGraph([node(1), node(2), node(3)], []);
    let pathfindingCalls = 0;

    const result = asRoute(
      optimizeMultiStopRoute(
        {
          originNodeId: 1,
          stopNodeIds: [2, 3]
        },
        graph,
        () => {
          pathfindingCalls += 1;
          return {
            distanceM: 10,
            path: [],
            nodesExplored: 1
          };
        }
      )
    );

    expect(result.optimizedOrder).toEqual([0, 1]);
    expect(pathfindingCalls).toBe(4);
  });

  it('handles duplicate stop nodes without adding distance or duplicate geometry', () => {
    const graph = new RoadGraph([node(1, 1, 1), node(2, 2, 2)], [edge(1, 2, 50)]);

    const result = asRoute(
      optimizeMultiStopRoute({ originNodeId: 1, stopNodeIds: [2, 2] }, graph, dijkstraShortestPath)
    );

    expect(result.totalDistanceM).toBe(50);
    expect(result.optimizedPath).toEqual([
      { lat: 1, lng: 1 },
      { lat: 2, lng: 2 }
    ]);
  });

  it('stays within 0% of brute-force optimal on an 8-stop metric fixture', () => {
    const points = [
      [0, 0],
      [1, 3],
      [4, 4],
      [6, 1],
      [2, -2],
      [5, -3],
      [8, 3],
      [9, -1],
      [3, 1]
    ] as const;
    const graph = buildCompleteMetricGraph(points);
    const request = {
      originNodeId: 1,
      stopNodeIds: [2, 3, 4, 5, 6, 7, 8, 9]
    };

    const result = asRoute(optimizeMultiStopRoute(request, graph, dijkstraShortestPath));
    const optimalDistanceM = bruteForceOptimalDistanceM(
      request.originNodeId,
      request.stopNodeIds,
      graph
    );
    const approximationGap = (result.totalDistanceM - optimalDistanceM) / optimalDistanceM;

    // Observed gap for this deterministic n=8 fixture is 0.00%; nearest-neighbor plus 2-opt
    // reaches the brute-force optimum, which is a useful portfolio talking point.
    expect(approximationGap).toBeLessThanOrEqual(0.05);
  });
});

function asRoute(result: OptimizedRoute | { status: number }): OptimizedRoute {
  if ('status' in result) {
    throw new Error(`Expected route, received error status ${result.status}`);
  }

  return result;
}

function buildCompleteMetricGraph(points: readonly (readonly [number, number])[]) {
  const nodes = points.map(([lat, lng], index) => node(index + 1, lat, lng));
  const edges: GraphEdge[] = [];

  for (const fromNode of nodes) {
    for (const toNode of nodes) {
      if (fromNode.id === toNode.id) {
        continue;
      }

      edges.push(
        edge(
          fromNode.id,
          toNode.id,
          Math.round(Math.hypot(fromNode.lat - toNode.lat, fromNode.lng - toNode.lng) * 100)
        )
      );
    }
  }

  return new RoadGraph(nodes, edges);
}

function bruteForceOptimalDistanceM(originNodeId: number, stopNodeIds: number[], graph: RoadGraph) {
  let bestDistanceM = Number.POSITIVE_INFINITY;

  for (const order of permutations(stopNodeIds)) {
    let distanceM = 0;
    let fromNodeId = originNodeId;

    for (const toNodeId of order) {
      const route = dijkstraShortestPath(fromNodeId, toNodeId, graph);

      if (!route) {
        throw new Error(`No route found between ${fromNodeId} and ${toNodeId}`);
      }

      distanceM += route.distanceM;
      fromNodeId = toNodeId;
    }

    bestDistanceM = Math.min(bestDistanceM, distanceM);
  }

  return bestDistanceM;
}

function permutations(values: number[]): number[][] {
  if (values.length === 0) {
    return [[]];
  }

  return values.flatMap((value, index) => {
    const remaining = [...values.slice(0, index), ...values.slice(index + 1)];

    return permutations(remaining).map((permutation) => [value, ...permutation]);
  });
}

function node(id: number, lat = 0, lng = 0): GraphNode {
  return { id, lat, lng };
}

function edge(fromNodeId: number, toNodeId: number, distanceM: number): GraphEdge {
  return { fromNodeId, toNodeId, distanceM };
}
