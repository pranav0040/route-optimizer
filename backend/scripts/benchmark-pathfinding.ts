import 'dotenv/config.js';

import { performance } from 'node:perf_hooks';

import { aStarShortestPath, dijkstraShortestPath } from '../src/algorithms/pathfinding.js';
import {
  type GraphEdge,
  type GraphNode,
  loadRoadGraph,
  RoadGraph
} from '../src/graph/road-graph.js';
import { pool } from '../src/db/pool.js';

interface BenchmarkStats {
  attempted: number;
  completed: number;
  unreachable: number;
  totalLatencyMs: number;
  totalNodesExplored: number;
}

const DEFAULT_PAIR_COUNT = 100;
const FIXTURE_WIDTH = 224;
const FIXTURE_HEIGHT = 224;
const FIXTURE_COORDINATE_STEP = 0.00005;
const FIXTURE_EDGE_DISTANCE_M = 10;

async function main() {
  const pairCount = parsePairCount(process.argv[2]);
  const useFixture = process.env.BENCHMARK_FIXTURE === 'true';
  const graph = useFixture ? createGridFixture() : await loadRoadGraph(pool);
  const nodeIds = graph.getNodeIds();

  if (nodeIds.length < 2) {
    throw new Error('Benchmark needs at least two graph nodes');
  }

  const pairs = createPairs(nodeIds, pairCount, useFixture);

  const dijkstraStats = runBenchmark('dijkstra', pairs, (start, end) =>
    dijkstraShortestPath(start, end, graph)
  );
  const aStarStats = runBenchmark('astar', pairs, (start, end) =>
    aStarShortestPath(start, end, graph)
  );

  console.log(
    JSON.stringify(
      {
        pairCount,
        dataset: useFixture ? 'deterministic-50k-node-grid' : 'postgres-road-graph',
        graph: {
          nodeCount: graph.nodeCount,
          edgeCount: graph.edgeCount
        },
        dijkstra: summarize(dijkstraStats),
        astar: summarize(aStarStats)
      },
      null,
      2
    )
  );
}

function runBenchmark(
  name: string,
  pairs: Array<[number, number]>,
  findPath: (startNodeId: number, endNodeId: number) => { nodesExplored: number } | null
) {
  const stats: BenchmarkStats = {
    attempted: pairs.length,
    completed: 0,
    unreachable: 0,
    totalLatencyMs: 0,
    totalNodesExplored: 0
  };

  for (const [startNodeId, endNodeId] of pairs) {
    const startedAt = performance.now();
    const result = findPath(startNodeId, endNodeId);
    const latencyMs = performance.now() - startedAt;

    stats.totalLatencyMs += latencyMs;

    if (!result) {
      stats.unreachable += 1;
      continue;
    }

    stats.completed += 1;
    stats.totalNodesExplored += result.nodesExplored;
  }

  console.log(`${name}: completed ${stats.completed}, unreachable ${stats.unreachable}`);

  return stats;
}

function summarize(stats: BenchmarkStats) {
  return {
    attempted: stats.attempted,
    completed: stats.completed,
    unreachable: stats.unreachable,
    averageLatencyMs: stats.attempted === 0 ? null : stats.totalLatencyMs / stats.attempted,
    averageNodesExplored: stats.completed === 0 ? null : stats.totalNodesExplored / stats.completed
  };
}

function createPairs(nodeIds: number[], pairCount: number, deterministic: boolean) {
  if (!deterministic) {
    return Array.from({ length: pairCount }, () => randomPair(nodeIds));
  }

  const random = seededRandom(42);

  return Array.from({ length: pairCount }, () => randomPair(nodeIds, random));
}

function randomPair(nodeIds: number[], random: () => number = Math.random): [number, number] {
  const startIndex = randomIndex(nodeIds.length, random);
  let endIndex = randomIndex(nodeIds.length, random);

  while (endIndex === startIndex) {
    endIndex = randomIndex(nodeIds.length, random);
  }

  return [nodeIds[startIndex], nodeIds[endIndex]];
}

function createGridFixture() {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (let row = 0; row < FIXTURE_HEIGHT; row += 1) {
    for (let column = 0; column < FIXTURE_WIDTH; column += 1) {
      const id = fixtureNodeId(row, column);

      nodes.push({
        id,
        lat: row * FIXTURE_COORDINATE_STEP,
        lng: column * FIXTURE_COORDINATE_STEP
      });

      if (column > 0) {
        addFixtureEdges(edges, id, fixtureNodeId(row, column - 1));
      }

      if (row > 0) {
        addFixtureEdges(edges, id, fixtureNodeId(row - 1, column));
      }
    }
  }

  return new RoadGraph(nodes, edges);
}

function fixtureNodeId(row: number, column: number) {
  return row * FIXTURE_WIDTH + column + 1;
}

function addFixtureEdges(edges: GraphEdge[], fromNodeId: number, toNodeId: number) {
  edges.push({ fromNodeId, toNodeId, distanceM: FIXTURE_EDGE_DISTANCE_M });
  edges.push({ fromNodeId: toNodeId, toNodeId: fromNodeId, distanceM: FIXTURE_EDGE_DISTANCE_M });
}

function seededRandom(seed: number) {
  let state = seed >>> 0;

  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function randomIndex(length: number, random: () => number = Math.random) {
  return Math.floor(random() * length);
}

function parsePairCount(value: string | undefined) {
  if (!value) {
    return DEFAULT_PAIR_COUNT;
  }

  const pairCount = Number(value);

  if (!Number.isInteger(pairCount) || pairCount <= 0) {
    throw new Error('Usage: pnpm benchmark:pathfinding -- [positive-pair-count]');
  }

  return pairCount;
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
