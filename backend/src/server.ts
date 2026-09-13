import 'dotenv/config.js';

import { createServer } from 'node:http';

import { createApp } from './app.js';
import {
  createRedisClient,
  getCacheTtlSeconds,
  RedisRouteResponseCache
} from './cache/route-cache.js';
import { PostgresJobRepository } from './db/job-repository.js';
import { initializeRoadGraph } from './graph/road-graph.js';
import { BullMqOptimizationJobQueue } from './jobs/optimization-queue.js';
import { RedisJobStatusPublisher, RedisJobStatusSubscriber } from './jobs/status-events.js';
import { apiLogger } from './logging/logger.js';
import { attachJobStatusWebSocket } from './websocket/job-status-websocket.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

async function main() {
  const graph = await initializeRoadGraph();
  const cacheClient = createRedisClient();
  const cache = new RedisRouteResponseCache(cacheClient, getCacheTtlSeconds());
  const repository = new PostgresJobRepository();
  const publisher = new RedisJobStatusPublisher();
  const subscriber = new RedisJobStatusSubscriber();
  const jobQueue = new BullMqOptimizationJobQueue(repository, publisher);
  const app = createApp({ graph, cache, jobQueue, jobRepository: repository });
  const server = createServer(app);

  const webSocketServer = await attachJobStatusWebSocket(server, repository, subscriber);

  server.listen(port, host, () => {
    apiLogger.info(
      { host, port, graphNodes: graph.nodeCount, graphEdges: graph.edgeCount },
      'API listening'
    );
  });

  const shutdown = async () => {
    for (const client of webSocketServer.clients) {
      client.terminate();
    }
    webSocketServer.close();
    server.close();
    await jobQueue.close();
    await publisher.close();
    await subscriber.close();
    await cacheClient.quit();
  };

  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

main().catch((error: unknown) => {
  apiLogger.fatal({ err: error }, 'API startup failed');
  process.exitCode = 1;
});
