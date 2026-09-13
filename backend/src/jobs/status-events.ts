import { Redis } from 'ioredis';

import { JOB_STATUS_CHANNEL, type JobStatusEvent, type JobStatusPublisher } from './types.js';

export type JobStatusListener = (event: JobStatusEvent) => void;

export interface JobStatusSubscriber {
  subscribe(listener: JobStatusListener): Promise<void>;
}

export class RedisJobStatusPublisher implements JobStatusPublisher {
  private readonly client: Redis;

  constructor(redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379') {
    this.client = redisClient(redisUrl);
  }

  async publish(event: JobStatusEvent) {
    await this.client.publish(JOB_STATUS_CHANNEL, JSON.stringify(event));
  }

  async close() {
    await this.client.quit();
  }
}

export class RedisJobStatusSubscriber implements JobStatusSubscriber {
  private readonly client: Redis;

  constructor(redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379') {
    this.client = redisClient(redisUrl);
  }

  async subscribe(listener: JobStatusListener) {
    this.client.on('message', (_channel, message) => {
      try {
        listener(JSON.parse(message) as JobStatusEvent);
      } catch (error) {
        console.error('Ignoring malformed job-status event.', error);
      }
    });
    await this.client.subscribe(JOB_STATUS_CHANNEL);
  }

  async close() {
    await this.client.quit();
  }
}

function redisClient(redisUrl: string) {
  const client = new Redis(redisUrl, { maxRetriesPerRequest: null });

  client.on('error', (error: Error) => {
    console.error('Job-status Redis connection error.', error.message);
  });

  return client;
}
