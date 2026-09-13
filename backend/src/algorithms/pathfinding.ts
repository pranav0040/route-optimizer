import { BinaryHeap } from './binary-heap.js';
import { getRoadGraph, type RoadGraph } from '../graph/road-graph.js';

export interface RouteCoordinate {
  lat: number;
  lng: number;
}

export interface ShortestPathResult {
  distanceM: number;
  path: RouteCoordinate[];
  nodesExplored: number;
}

interface QueueEntry {
  nodeId: number;
  distanceM: number;
}

/**
 * Dijkstra over an adjacency-list graph using a binary heap priority queue.
 * Time: O((V + E) log V). Space: O(V).
 */
export function dijkstraShortestPath(
  startNodeId: number,
  endNodeId: number,
  graph: RoadGraph = getRoadGraph()
): ShortestPathResult | null {
  if (!graph.getNode(startNodeId) || !graph.getNode(endNodeId)) {
    return null;
  }

  return shortestPath(startNodeId, endNodeId, graph, () => 0);
}

/**
 * A* over an adjacency-list graph using a binary heap priority queue.
 * Time: O((V + E) log V) in the worst case. Space: O(V).
 */
export function aStarShortestPath(
  startNodeId: number,
  endNodeId: number,
  graph: RoadGraph = getRoadGraph()
): ShortestPathResult | null {
  const goal = graph.getNode(endNodeId);

  if (!graph.getNode(startNodeId) || !goal) {
    return null;
  }

  return shortestPath(startNodeId, endNodeId, graph, (nodeId) => {
    const node = graph.getNode(nodeId);

    if (!node) {
      return Number.POSITIVE_INFINITY;
    }

    /*
     * Haversine is admissible here because it is the straight-line great-circle
     * distance to the goal. Ingested edge weights are haversine segment lengths,
     * and by the triangle inequality any drivable route made of those segments
     * cannot be shorter than the direct great-circle distance.
     */
    return haversineDistanceM(node, goal);
  });
}

function shortestPath(
  startNodeId: number,
  endNodeId: number,
  graph: RoadGraph,
  heuristicM: (nodeId: number) => number
) {
  const distances = new Map<number, number>([[startNodeId, 0]]);
  const previous = new Map<number, number>();
  const settled = new Set<number>();
  const queue = new BinaryHeap<QueueEntry>();
  let nodesExplored = 0;

  queue.push({ nodeId: startNodeId, distanceM: 0 }, heuristicM(startNodeId));

  while (queue.size > 0) {
    const current = queue.pop();

    if (!current || settled.has(current.nodeId)) {
      continue;
    }

    settled.add(current.nodeId);
    nodesExplored += 1;

    if (current.nodeId === endNodeId) {
      return {
        distanceM: current.distanceM,
        path: buildPathCoordinates(startNodeId, endNodeId, previous, graph),
        nodesExplored
      };
    }

    for (const edge of graph.getNeighbors(current.nodeId)) {
      if (settled.has(edge.toNodeId)) {
        continue;
      }

      const nextDistanceM = current.distanceM + edge.distanceM;
      const bestKnownDistanceM = distances.get(edge.toNodeId) ?? Number.POSITIVE_INFINITY;

      if (nextDistanceM >= bestKnownDistanceM) {
        continue;
      }

      distances.set(edge.toNodeId, nextDistanceM);
      previous.set(edge.toNodeId, current.nodeId);
      queue.push(
        { nodeId: edge.toNodeId, distanceM: nextDistanceM },
        nextDistanceM + heuristicM(edge.toNodeId)
      );
    }
  }

  return null;
}

function buildPathCoordinates(
  startNodeId: number,
  endNodeId: number,
  previous: Map<number, number>,
  graph: RoadGraph
) {
  const nodeIds = [endNodeId];
  let currentNodeId = endNodeId;

  while (currentNodeId !== startNodeId) {
    const previousNodeId = previous.get(currentNodeId);

    if (previousNodeId === undefined) {
      return [];
    }

    nodeIds.push(previousNodeId);
    currentNodeId = previousNodeId;
  }

  nodeIds.reverse();

  return nodeIds.map((nodeId) => {
    const node = graph.getNode(nodeId);

    if (!node) {
      throw new Error(`Path references missing node ${nodeId}`);
    }

    return { lat: node.lat, lng: node.lng };
  });
}

export function haversineDistanceM(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number }
) {
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
