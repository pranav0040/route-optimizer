import { randomUUID } from 'node:crypto';

import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import {
  ROUTE_OPTIMIZATION_QUEUE,
  type JobRepository,
  type JobStatusPublisher,
  type OptimizationJobData,
  type OptimizationJobQueue
} from './types.js';
import { apiLogger } from '../logging/logger.js';

const TOTAL_ATTEMPTS = 3;
const INITIAL_BACKOFF_MS = 1_000;

export class BullMqOptimizationJobQueue implements OptimizationJobQueue {
  private readonly connection: Redis;
  private readonly queue: Queue<OptimizationJobData>;

  constructor(
    private readonly repository: JobRepository,
    private readonly publisher: JobStatusPublisher,
    redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379'
  ) {
    this.connection = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    this.connection.on('error', (error: Error) => {
      console.error('BullMQ producer Redis connection error.', error.message);
    });
    this.queue = new Queue<OptimizationJobData>(ROUTE_OPTIMIZATION_QUEUE, {
      connection: this.connection
    });
  }

  async enqueue(data: OptimizationJobData) {
    const jobId = randomUUID();

    await this.repository.createJob(jobId, data);

    try {
      await this.queue.add('optimize-route', data, {
        jobId,
        attempts: TOTAL_ATTEMPTS,
        backoff: { type: 'exponential', delay: INITIAL_BACKOFF_MS },
        removeOnComplete: 100,
        removeOnFail: false
      });
    } catch (error) {
      const reason = errorMessage(error);

      await this.repository.failJob(jobId, reason);
      await safePublish(this.publisher, {
        jobId,
        status: 'failed',
        routeId: null,
        errorReason: reason
      });
      throw error;
    }

    await safePublish(this.publisher, {
      jobId,
      status: 'queued',
      routeId: null,
      errorReason: null
    });
    apiLogger.info({ jobId, status: 'queued', stopCount: data.stops.length }, 'Job queued');
    return jobId;
  }

  async close() {
    await this.queue.close();
    await this.connection.quit();
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function safePublish(
  publisher: JobStatusPublisher,
  event: Parameters<JobStatusPublisher['publish']>[0]
) {
  try {
    await publisher.publish(event);
  } catch (error) {
    console.error('Could not publish job-status event.', error);
  }
}
