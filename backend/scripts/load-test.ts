import { createServer, type Server } from 'node:http';

import autocannon, { type Options, type Result } from 'autocannon';

import { type GraphEdge, type GraphNode, RoadGraph } from '../src/graph/road-graph.js';

const GRID_WIDTH = 224;
const GRID_HEIGHT = 224;
const COORDINATE_STEP = 0.00005;
const EDGE_DISTANCE_M = 10;

async function main() {
  const useFixture = process.env.LOAD_TEST_FIXTURE === 'true';
  const connections = positiveInteger('LOAD_TEST_CONNECTIONS', 20);
  const duration = positiveInteger('LOAD_TEST_DURATION_SECONDS', 15);
  const pipelining = positiveInteger('LOAD_TEST_PIPELINING', 1);
  const fixture = useFixture ? await startFixtureServer() : null;
  const baseUrl = fixture?.baseUrl ?? process.env.LOAD_TEST_BASE_URL ?? 'http://localhost:3000';
  const body = process.env.LOAD_TEST_PAYLOAD ?? JSON.stringify(fixturePayload(useFixture));
  const url = `${baseUrl.replace(/\/$/, '')}/api/routes/point-to-point`;

  try {
    const result = await runAutocannon({
      url,
      connections,
      duration,
      pipelining,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body
    });
    const summary = {
      generatedAt: new Date().toISOString(),
      target: url,
      mode: useFixture ? 'deterministic-50k-node-fixture' : 'running-stack',
      connections,
      durationSeconds: duration,
      pipelining,
      requests: {
        total: result.requests.total,
        averagePerSecond: result.requests.average,
        errors: result.errors,
        timeouts: result.timeouts,
        non2xx: result.non2xx
      },
      latencyMs: {
        average: result.latency.average,
        p50: result.latency.p50,
        p90: result.latency.p90,
        p97_5: result.latency.p97_5,
        p99: result.latency.p99,
        max: result.latency.max
      },
      throughputBytesPerSecond: result.throughput.average,
      statusCodeStats: result.statusCodeStats
    };

    console.log(JSON.stringify(summary, null, 2));

    if (result.errors > 0 || result.timeouts > 0 || result.non2xx > 0) {
      process.exitCode = 1;
    }
  } finally {
    await closeServer(fixture?.server);
  }
}

async function startFixtureServer() {
  process.env.LOG_LEVEL = 'silent';
  process.env.RATE_LIMIT_MAX = '1000000';

  const [{ createApp }, fixture] = await Promise.all([
    import('../src/app.js'),
    Promise.resolve(createGridFixture())
  ]);
  const app = createApp({
    graph: fixture.graph,
    snapCoordinate: async (lat, lng) => fixture.nodesByCoordinate.get(`${lat},${lng}`) ?? null
  });
  const server = createServer(app);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Could not determine the fixture server address.');
  }

  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function createGridFixture() {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodesByCoordinate = new Map<
    string,
    { id: number; lat: number; lng: number; distanceM: number }
  >();

  for (let row = 0; row < GRID_HEIGHT; row += 1) {
    for (let column = 0; column < GRID_WIDTH; column += 1) {
      const id = nodeId(row, column);
      const lat = row * COORDINATE_STEP;
      const lng = column * COORDINATE_STEP;
      const node = { id, lat, lng };

      nodes.push(node);
      nodesByCoordinate.set(`${lat},${lng}`, { ...node, distanceM: 0 });

      if (column > 0) {
        addBidirectionalEdge(edges, id, nodeId(row, column - 1));
      }

      if (row > 0) {
        addBidirectionalEdge(edges, id, nodeId(row - 1, column));
      }
    }
  }

  return { graph: new RoadGraph(nodes, edges), nodesByCoordinate };
}

function fixturePayload(useFixture: boolean) {
  if (!useFixture) {
    return {
      origin: { lat: 12.9716, lng: 77.5946 },
      destination: { lat: 12.9352, lng: 77.6146 },
      algorithm: 'astar'
    };
  }

  return {
    origin: { lat: 0, lng: 0 },
    destination: { lat: 20 * COORDINATE_STEP, lng: 20 * COORDINATE_STEP },
    algorithm: 'astar'
  };
}

function nodeId(row: number, column: number) {
  return row * GRID_WIDTH + column + 1;
}

function addBidirectionalEdge(edges: GraphEdge[], fromNodeId: number, toNodeId: number) {
  edges.push({ fromNodeId, toNodeId, distanceM: EDGE_DISTANCE_M });
  edges.push({ fromNodeId: toNodeId, toNodeId: fromNodeId, distanceM: EDGE_DISTANCE_M });
}

function runAutocannon(options: Options) {
  return new Promise<Result>((resolve, reject) => {
    autocannon(options, (error, result) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(result);
    });
  });
}

function positiveInteger(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);

  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }

  return value;
}

async function closeServer(server: Server | undefined) {
  if (!server) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
