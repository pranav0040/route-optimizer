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

  constructor(nodes: GraphNode[], edges: GraphEdge[]) {
    for (const node of nodes) {
      this.nodesById.set(node.id, node);
      this.adjacencyByNodeId.set(node.id, []);
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
    }
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

  getNode(nodeId: number) {
    return this.nodesById.get(nodeId) ?? null;
  }

  getNeighbors(nodeId: number) {
    return this.adjacencyByNodeId.get(nodeId) ?? [];
  }

  getNodeIds() {
    return Array.from(this.nodesById.keys());
  }
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
