import 'dotenv/config.js';

import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';

import {
  createRedisClient,
  getCacheTtlSeconds,
  RedisRouteResponseCache
} from './cache/route-cache.js';
import { PostgresJobRepository } from './db/job-repository.js';
import { initializeRoadGraph } from './graph/road-graph.js';
import { processOptimizationJob } from './jobs/optimization-processor.js';
import { RedisJobStatusPublisher } from './jobs/status-events.js';
import { ROUTE_OPTIMIZATION_QUEUE, type OptimizationJobData } from './jobs/types.js';
import { workerLogger } from './logging/logger.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

async function main() {
  const graph = await initializeRoadGraph();
  const repository = new PostgresJobRepository();
  const publisher = new RedisJobStatusPublisher(redisUrl);
  const cacheClient = createRedisClient(redisUrl);
  const cache = new RedisRouteResponseCache(cacheClient, getCacheTtlSeconds());
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const worker = new Worker<OptimizationJobData>(
    ROUTE_OPTIMIZATION_QUEUE,
    async (job) => processJobWithRetryStatus(job, { graph, repository, publisher, cache }),
    { connection }
  );

  connection.on('error', (error: Error) => {
    workerLogger.error({ err: error }, 'BullMQ worker Redis connection error');
  });
  worker.on('active', (job) => {
    workerLogger.info({ jobId: job.id, status: 'processing' }, 'Job processing');
  });
  worker.on('completed', (job, result) => {
    workerLogger.info(
      { jobId: job.id, routeId: result.routeId, status: 'completed' },
      'Job completed'
    );
  });
  worker.on('failed', (job, error) => {
    workerLogger.error(
      { err: error, jobId: job?.id, attempt: job?.attemptsMade, status: 'failed' },
      'Optimization job attempt failed'
    );
  });
  worker.on('error', (error) => {
    workerLogger.error({ err: error }, 'Optimization worker error');
  });

  const shutdown = async () => {
    await worker.close();
    await publisher.close();
    await cacheClient.quit();
    await connection.quit();
  };

  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());

  workerLogger.info(
    { graphNodes: graph.nodeCount, graphEdges: graph.edgeCount },
    'Route optimizer worker started'
  );
}

async function processJobWithRetryStatus(
  job: Job<OptimizationJobData>,
  dependencies: Parameters<typeof processOptimizationJob>[2]
) {
  if (!job.id) {
    throw new Error('BullMQ delivered an optimization job without an ID.');
  }

  try {
    return await processOptimizationJob(job.id, job.data, dependencies);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const attempts = job.opts.attempts ?? 1;
    const isFinalAttempt = job.attemptsMade + 1 >= attempts;

    if (isFinalAttempt) {
      await dependencies.repository.failJob(job.id, reason);
      await safePublish(dependencies.publisher, {
        jobId: job.id,
        status: 'failed',
        routeId: null,
        errorReason: reason
      });
    } else {
      await dependencies.repository.markQueued(job.id);
      await safePublish(dependencies.publisher, {
        jobId: job.id,
        status: 'queued',
        routeId: null,
        errorReason: null
      });
    }

    throw error;
  }
}

async function safePublish(
  publisher: Parameters<typeof processOptimizationJob>[2]['publisher'],
  event: Parameters<Parameters<typeof processOptimizationJob>[2]['publisher']['publish']>[0]
) {
  try {
    await publisher.publish(event);
  } catch (error) {
    console.error('Could not publish job-status event.', error);
  }
}

main().catch((error: unknown) => {
  workerLogger.fatal({ err: error }, 'Worker startup failed');
  process.exitCode = 1;
});
