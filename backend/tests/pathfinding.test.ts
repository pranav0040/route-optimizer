import { describe, expect, it } from 'vitest';

import { aStarShortestPath, dijkstraShortestPath } from '../src/algorithms/pathfinding.js';
import { type GraphEdge, type GraphNode, RoadGraph } from '../src/graph/road-graph.js';

describe('shortest path algorithms', () => {
  it('identifies the largest strongly connected component as routable', () => {
    const graph = new RoadGraph(
      [node(1, 0, 0), node(2, 0, 1), node(3, 0, 2), node(4, 1, 0), node(5, 1, 1)],
      [
        edge(1, 2, 1),
        edge(2, 1, 1),
        edge(2, 3, 1),
        edge(3, 2, 1),
        edge(4, 5, 1),
        edge(5, 4, 1)
      ]
    );

    expect(graph.routableNodeCount).toBe(3);
    expect([1, 2, 3].every((nodeId) => graph.isRoutableNode(nodeId))).toBe(true);
    expect([4, 5].every((nodeId) => graph.isRoutableNode(nodeId))).toBe(false);
  });

  it.each([
    ['dijkstra', dijkstraShortestPath],
    ['astar', aStarShortestPath]
  ])('finds the known shortest path on a hand-built 5-node graph with %s', (_name, findPath) => {
    const graph = new RoadGraph(
      [
        node(1, 0, 0),
        node(2, 0, 0.000001),
        node(3, 0, 0.000002),
        node(4, 0.000001, 0.000001),
        node(5, 0.000001, 0.000002)
      ],
      [edge(1, 2, 2), edge(2, 3, 2), edge(1, 4, 1), edge(4, 5, 1), edge(5, 3, 1), edge(2, 5, 10)]
    );

    const result = findPath(1, 3, graph);

    expect(result).toEqual({
      distanceM: 3,
      path: [
        { lat: 0, lng: 0 },
        { lat: 0.000001, lng: 0.000001 },
        { lat: 0.000001, lng: 0.000002 },
        { lat: 0, lng: 0.000002 }
      ],
      nodesExplored: expect.any(Number)
    });
    expect(result?.nodesExplored).toBeGreaterThan(0);
  });

  it.each([
    ['dijkstra', dijkstraShortestPath],
    ['astar', aStarShortestPath]
  ])('returns null for a disconnected graph with %s', (_name, findPath) => {
    const graph = new RoadGraph([node(1, 0, 0), node(2, 0, 1), node(3, 10, 10)], [edge(1, 2, 1)]);

    expect(findPath(1, 3, graph)).toBeNull();
  });

  it.each([
    ['dijkstra', dijkstraShortestPath],
    ['astar', aStarShortestPath]
  ])('returns a zero-distance route for the same start and end node with %s', (_name, findPath) => {
    const graph = new RoadGraph([node(1, 43.0731, -89.4012)], []);

    expect(findPath(1, 1, graph)).toEqual({
      distanceM: 0,
      path: [{ lat: 43.0731, lng: -89.4012 }],
      nodesExplored: 1
    });
  });
});

function node(id: number, lat: number, lng: number): GraphNode {
  return { id, lat, lng };
}

function edge(fromNodeId: number, toNodeId: number, distanceM: number): GraphEdge {
  return { fromNodeId, toNodeId, distanceM };
}
