/**
 * One-time OSM road-network ingestion for the MVP graph.
 *
 * Suggested demo extract: a bounded Bengaluru, India `.osm.pbf` export covering
 * the coordinates used by the frontend examples.
 *
 * The bounded city extract is intentionally large enough to exercise real road-network
 * topology, but small enough for local PostGIS ingestion during portfolio/demo development.
 * Put the `.osm.pbf` file in `data/`, then run:
 *
 *   docker compose run --rm migrate node dist/scripts/ingest-osm.js /data/Bengaluru.osm.pbf
 *
 * The parser keeps only drivable OSM `highway` ways and writes a static graph. It does not
 * fetch map data at runtime, matching the SRS v1 constraint.
 */
import 'dotenv/config.js';

import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { pool, type Queryable } from '../src/db/pool.js';

const require = createRequire(import.meta.url);
const parseOsm = require('osm-pbf-parser') as () => NodeJS.ReadWriteStream;

type Direction = 'forward' | 'reverse' | 'both';

interface OsmNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
}

interface OsmWay {
  type: 'way';
  id: number;
  refs: number[];
  tags?: Record<string, string>;
}

type OsmElement = OsmNode | OsmWay | { type: string };

interface DrivableWay {
  id: number;
  refs: number[];
  roadClass: string;
  speedEstimate: number;
  direction: Direction;
}

interface GraphNode {
  id: number;
  lat: number;
  lng: number;
}

interface GraphEdge {
  fromNodeId: number;
  toNodeId: number;
  distanceM: number;
  speedEstimate: number;
  roadClass: string;
}

const DRIVABLE_HIGHWAYS = new Set([
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'unclassified',
  'residential',
  'living_street',
  'service',
  'motorway_link',
  'trunk_link',
  'primary_link',
  'secondary_link',
  'tertiary_link',
  'road'
]);

const SPEED_BY_HIGHWAY_KPH: Record<string, number> = {
  motorway: 100,
  trunk: 80,
  primary: 65,
  secondary: 55,
  tertiary: 45,
  unclassified: 35,
  residential: 30,
  living_street: 15,
  service: 15,
  motorway_link: 55,
  trunk_link: 50,
  primary_link: 45,
  secondary_link: 40,
  tertiary_link: 35,
  road: 30
};

const INSERT_BATCH_SIZE = 5_000;

async function main() {
  const pbfPath = process.argv[2];

  if (!pbfPath) {
    throw new Error('Usage: pnpm ingest:osm -- <path-to-osm-pbf>');
  }

  const resolvedPath = path.resolve(pbfPath);
  await access(resolvedPath);

  console.log(`Scanning drivable ways from ${resolvedPath}`);
  const { ways, referencedNodeIds } = await collectDrivableWays(resolvedPath);
  console.log(`Found ${ways.length} drivable ways referencing ${referencedNodeIds.size} nodes.`);

  console.log('Collecting referenced node coordinates.');
  const nodes = await collectReferencedNodes(resolvedPath, referencedNodeIds);
  console.log(`Resolved ${nodes.size} graph nodes.`);

  const edges = buildEdges(ways, nodes);
  const componentSummary = summarizeComponents(nodes, edges);

  await replaceRoadGraph(pool, nodes, edges);

  console.log(
    JSON.stringify(
      {
        nodeCount: nodes.size,
        edgeCount: edges.length,
        componentCount: componentSummary.componentCount,
        largestComponentNodeCount: componentSummary.largestComponentNodeCount
      },
      null,
      2
    )
  );

  if (componentSummary.componentCount > 1) {
    console.warn(
      `Warning: graph has ${componentSummary.componentCount} disconnected components; largest has ${componentSummary.largestComponentNodeCount} nodes.`
    );
  }

  await pool.end();
}

async function collectDrivableWays(filePath: string) {
  const ways: DrivableWay[] = [];
  const referencedNodeIds = new Set<number>();

  for await (const items of readOsm(filePath)) {
    for (const item of items) {
      if (!isWay(item) || !isDrivableWay(item)) {
        continue;
      }

      const highway = item.tags?.highway;
      const refs = item.refs.filter((ref) => Number.isFinite(ref));

      if (!highway || refs.length < 2) {
        continue;
      }

      for (const ref of refs) {
        referencedNodeIds.add(ref);
      }

      ways.push({
        id: item.id,
        refs,
        roadClass: highway,
        speedEstimate: parseMaxspeedKph(item.tags?.maxspeed) ?? SPEED_BY_HIGHWAY_KPH[highway],
        direction: getDirection(item.tags)
      });
    }
  }

  return { ways, referencedNodeIds };
}

async function collectReferencedNodes(filePath: string, referencedNodeIds: Set<number>) {
  const nodes = new Map<number, GraphNode>();

  for await (const items of readOsm(filePath)) {
    for (const item of items) {
      if (!isNode(item) || !referencedNodeIds.has(item.id)) {
        continue;
      }

      nodes.set(item.id, {
        id: item.id,
        lat: item.lat,
        lng: item.lon
      });
    }
  }

  return nodes;
}

async function* readOsm(filePath: string): AsyncGenerator<OsmElement[]> {
  const stream = createReadStream(filePath).pipe(parseOsm());
  const batches: OsmElement[][] = [];
  let completed = false;
  let failure: Error | null = null;
  let wakeConsumer: (() => void) | null = null;

  const wake = () => {
    wakeConsumer?.();
    wakeConsumer = null;
  };

  stream.on('data', (items: OsmElement[]) => {
    batches.push(items);
    wake();
  });
  stream.once('end', () => {
    completed = true;
    wake();
  });
  stream.once('error', (error: Error) => {
    failure = error;
    completed = true;
    wake();
  });

  try {
    while (!completed || batches.length > 0) {
      if (failure) {
        throw failure;
      }

      const items = batches.shift();

      if (items) {
        yield items;
        continue;
      }

      await new Promise<void>((resolve) => {
        wakeConsumer = resolve;
      });
    }

    if (failure) {
      throw failure;
    }
  } finally {
    (stream as NodeJS.ReadWriteStream & { destroy?: () => void }).destroy?.();
  }
}

function buildEdges(ways: DrivableWay[], nodes: Map<number, GraphNode>) {
  const edges: GraphEdge[] = [];

  for (const way of ways) {
    for (let index = 0; index < way.refs.length - 1; index += 1) {
      const from = nodes.get(way.refs[index]);
      const to = nodes.get(way.refs[index + 1]);

      if (!from || !to) {
        continue;
      }

      const distanceM = haversineDistanceM(from, to);

      if (way.direction === 'forward' || way.direction === 'both') {
        edges.push({
          fromNodeId: from.id,
          toNodeId: to.id,
          distanceM,
          speedEstimate: way.speedEstimate,
          roadClass: way.roadClass
        });
      }

      if (way.direction === 'reverse' || way.direction === 'both') {
        edges.push({
          fromNodeId: to.id,
          toNodeId: from.id,
          distanceM,
          speedEstimate: way.speedEstimate,
          roadClass: way.roadClass
        });
      }
    }
  }

  return edges;
}

async function replaceRoadGraph(
  client: Queryable,
  nodes: Map<number, GraphNode>,
  edges: GraphEdge[]
) {
  await client.query('BEGIN');

  try {
    await client.query('TRUNCATE TABLE edges, nodes RESTART IDENTITY');
    await insertNodes(client, Array.from(nodes.values()));
    await insertEdges(client, edges);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function insertNodes(client: Queryable, nodes: GraphNode[]) {
  for (let offset = 0; offset < nodes.length; offset += INSERT_BATCH_SIZE) {
    const batch = nodes.slice(offset, offset + INSERT_BATCH_SIZE);
    const values: Array<number> = [];
    const placeholders = batch.map((node, index) => {
      const base = index * 3;
      values.push(node.id, node.lat, node.lng);
      return `($${base + 1}, $${base + 2}, $${base + 3}, ST_SetSRID(ST_MakePoint($${base + 3}, $${base + 2}), 4326)::geography)`;
    });

    await client.query(
      `
        INSERT INTO nodes (id, lat, lng, geom)
        VALUES ${placeholders.join(', ')}
        ON CONFLICT (id) DO UPDATE SET
          lat = EXCLUDED.lat,
          lng = EXCLUDED.lng,
          geom = EXCLUDED.geom
      `,
      values
    );
  }
}

async function insertEdges(client: Queryable, edges: GraphEdge[]) {
  for (let offset = 0; offset < edges.length; offset += INSERT_BATCH_SIZE) {
    const batch = edges.slice(offset, offset + INSERT_BATCH_SIZE);
    const values: Array<number | string> = [];
    const placeholders = batch.map((edge, index) => {
      const base = index * 5;
      values.push(
        edge.fromNodeId,
        edge.toNodeId,
        edge.distanceM,
        edge.speedEstimate,
        edge.roadClass
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
    });

    await client.query(
      `
        INSERT INTO edges (from_node_id, to_node_id, distance_m, speed_estimate, road_class)
        VALUES ${placeholders.join(', ')}
      `,
      values
    );
  }
}

function summarizeComponents(nodes: Map<number, GraphNode>, edges: GraphEdge[]) {
  const adjacency = new Map<number, Set<number>>();

  for (const nodeId of nodes.keys()) {
    adjacency.set(nodeId, new Set());
  }

  for (const edge of edges) {
    adjacency.get(edge.fromNodeId)?.add(edge.toNodeId);
    adjacency.get(edge.toNodeId)?.add(edge.fromNodeId);
  }

  const visited = new Set<number>();
  let componentCount = 0;
  let largestComponentNodeCount = 0;

  for (const nodeId of adjacency.keys()) {
    if (visited.has(nodeId)) {
      continue;
    }

    componentCount += 1;
    const componentSize = visitComponent(nodeId, adjacency, visited);
    largestComponentNodeCount = Math.max(largestComponentNodeCount, componentSize);
  }

  return { componentCount, largestComponentNodeCount };
}

function visitComponent(
  startNodeId: number,
  adjacency: Map<number, Set<number>>,
  visited: Set<number>
) {
  const stack = [startNodeId];
  let size = 0;

  while (stack.length > 0) {
    const nodeId = stack.pop();

    if (nodeId === undefined || visited.has(nodeId)) {
      continue;
    }

    visited.add(nodeId);
    size += 1;

    for (const neighborId of adjacency.get(nodeId) ?? []) {
      if (!visited.has(neighborId)) {
        stack.push(neighborId);
      }
    }
  }

  return size;
}

function isDrivableWay(way: OsmWay) {
  const tags = way.tags ?? {};
  const highway = tags.highway;

  if (!highway || !DRIVABLE_HIGHWAYS.has(highway)) {
    return false;
  }

  if (tags.area === 'yes') {
    return false;
  }

  return !['no', 'private'].some((blockedAccess) =>
    [tags.access, tags.vehicle, tags.motor_vehicle].includes(blockedAccess)
  );
}

function getDirection(tags: Record<string, string> = {}): Direction {
  if (tags.oneway === '-1') {
    return 'reverse';
  }

  if (['yes', 'true', '1'].includes(tags.oneway) || tags.junction === 'roundabout') {
    return 'forward';
  }

  return 'both';
}

function parseMaxspeedKph(maxspeed: string | undefined) {
  if (!maxspeed) {
    return null;
  }

  const numericValue = Number.parseFloat(maxspeed);

  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return null;
  }

  return maxspeed.toLowerCase().includes('mph') ? numericValue * 1.60934 : numericValue;
}

function haversineDistanceM(from: GraphNode, to: GraphNode) {
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

function isNode(item: OsmElement): item is OsmNode {
  return item.type === 'node';
}

function isWay(item: OsmElement): item is OsmWay {
  return item.type === 'way';
}

main().catch(async (error: unknown) => {
  console.error(error);
  await pool.end();
  process.exitCode = 1;
});
