import { pool, type Queryable } from '../db/pool.js';

export interface GraphNode {
  id: number;
  lat: number;
  lng: number;
}

export interface GraphEdge {
  fromNodeId: number;
  toNodeId: number;
  distanceM: number;
}

export interface AdjacentEdge {
  toNodeId: number;
  distanceM: number;
}

export interface GraphBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

interface NodeRow {
  id: string | number;
  lat: string | number;
  lng: string | number;
}

interface EdgeRow {
  from_node_id: string | number;
  to_node_id: string | number;
  distance_m: string | number;
}

export class RoadGraph {
  private readonly nodesById = new Map<number, GraphNode>();
  private readonly adjacencyByNodeId = new Map<number, AdjacentEdge[]>();
  private readonly reverseAdjacencyByNodeId = new Map<number, number[]>();
  private readonly routableNodeIds: Set<number>;
  private readonly routableBoundsValue: GraphBounds | null;

  constructor(nodes: GraphNode[], edges: GraphEdge[]) {
    for (const node of nodes) {
      this.nodesById.set(node.id, node);
      this.adjacencyByNodeId.set(node.id, []);
      this.reverseAdjacencyByNodeId.set(node.id, []);
    }

    for (const edge of edges) {
      const adjacency = this.adjacencyByNodeId.get(edge.fromNodeId);

      if (!adjacency || !this.nodesById.has(edge.toNodeId)) {
        continue;
      }

      adjacency.push({
        toNodeId: edge.toNodeId,
        distanceM: edge.distanceM
      });
      this.reverseAdjacencyByNodeId.get(edge.toNodeId)?.push(edge.fromNodeId);
    }

    this.routableNodeIds = largestStronglyConnectedComponent(
      this.adjacencyByNodeId,
      this.reverseAdjacencyByNodeId
    );
    this.routableBoundsValue = calculateBounds(this.nodesById, this.routableNodeIds);
  }

  get nodeCount() {
    return this.nodesById.size;
  }

  get edgeCount() {
    let count = 0;

    for (const edges of this.adjacencyByNodeId.values()) {
      count += edges.length;
    }

    return count;
  }

  get routableNodeCount() {
    return this.routableNodeIds.size;
  }

  get routableBounds() {
    return this.routableBoundsValue ? { ...this.routableBoundsValue } : null;
  }

  getNode(nodeId: number) {
    return this.nodesById.get(nodeId) ?? null;
  }

  getNeighbors(nodeId: number) {
    return this.adjacencyByNodeId.get(nodeId) ?? [];
  }

  getNodeIds() {
    return Array.from(this.nodesById.keys());
  }

  isRoutableNode(nodeId: number) {
    return this.routableNodeIds.has(nodeId);
  }
}

function calculateBounds(nodes: Map<number, GraphNode>, includedNodeIds: Set<number>) {
  let south = Number.POSITIVE_INFINITY;
  let west = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;

  for (const nodeId of includedNodeIds) {
    const node = nodes.get(nodeId);

    if (!node) {
      continue;
    }

    south = Math.min(south, node.lat);
    west = Math.min(west, node.lng);
    north = Math.max(north, node.lat);
    east = Math.max(east, node.lng);
  }

  return Number.isFinite(south) ? { south, west, north, east } : null;
}

function largestStronglyConnectedComponent(
  adjacency: Map<number, AdjacentEdge[]>,
  reverseAdjacency: Map<number, number[]>
) {
  const visited = new Set<number>();
  const finishOrder: number[] = [];

  for (const startNodeId of adjacency.keys()) {
    if (visited.has(startNodeId)) {
      continue;
    }

    visited.add(startNodeId);
    const stack: Array<{ nodeId: number; nextNeighborIndex: number }> = [
      { nodeId: startNodeId, nextNeighborIndex: 0 }
    ];

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const neighbors = adjacency.get(frame.nodeId) ?? [];
      const neighbor = neighbors[frame.nextNeighborIndex];

      if (neighbor) {
        frame.nextNeighborIndex += 1;

        if (!visited.has(neighbor.toNodeId)) {
          visited.add(neighbor.toNodeId);
          stack.push({ nodeId: neighbor.toNodeId, nextNeighborIndex: 0 });
        }

        continue;
      }

      finishOrder.push(frame.nodeId);
      stack.pop();
    }
  }

  const assigned = new Set<number>();
  let largestComponent = new Set<number>();

  for (let index = finishOrder.length - 1; index >= 0; index -= 1) {
    const startNodeId = finishOrder[index];

    if (assigned.has(startNodeId)) {
      continue;
    }

    const component = new Set<number>();
    const stack = [startNodeId];
    assigned.add(startNodeId);

    while (stack.length > 0) {
      const nodeId = stack.pop();

      if (nodeId === undefined) {
        continue;
      }

      component.add(nodeId);

      for (const neighborId of reverseAdjacency.get(nodeId) ?? []) {
        if (!assigned.has(neighborId)) {
          assigned.add(neighborId);
          stack.push(neighborId);
        }
      }
    }

    if (component.size > largestComponent.size) {
      largestComponent = component;
    }
  }

  return largestComponent;
}

let activeRoadGraph: RoadGraph | null = null;

export async function initializeRoadGraph(client: Queryable = pool) {
  activeRoadGraph = await loadRoadGraph(client);
  return activeRoadGraph;
}

export function getRoadGraph() {
  if (!activeRoadGraph) {
    throw new Error('Road graph has not been initialized');
  }

  return activeRoadGraph;
}

export function setRoadGraphForTesting(graph: RoadGraph | null) {
  activeRoadGraph = graph;
}

export async function loadRoadGraph(client: Queryable = pool) {
  const nodeResult = await client.query<NodeRow>('SELECT id, lat, lng FROM nodes');
  const edgeResult = await client.query<EdgeRow>(
    'SELECT from_node_id, to_node_id, distance_m FROM edges'
  );

  const nodes = nodeResult.rows.map((row) => ({
    id: Number(row.id),
    lat: Number(row.lat),
    lng: Number(row.lng)
  }));

  const edges = edgeResult.rows.map((row) => ({
    fromNodeId: Number(row.from_node_id),
    toNodeId: Number(row.to_node_id),
    distanceM: Number(row.distance_m)
  }));

  return new RoadGraph(nodes, edges);
}
