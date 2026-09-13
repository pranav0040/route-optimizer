import { Redis } from 'ioredis';

export const DEFAULT_CACHE_TTL_SECONDS = 24 * 60 * 60;

export interface CacheClient {
  get(key: string): Promise<string | null>;
  setex(key: string, ttlSeconds: number, value: string): Promise<unknown>;
}

export interface RouteResponseCache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
}

export class RedisRouteResponseCache implements RouteResponseCache {
  constructor(
    private readonly client: CacheClient,
    private readonly ttlSeconds = DEFAULT_CACHE_TTL_SECONDS
  ) {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new RangeError('Cache TTL must be a positive integer number of seconds.');
    }
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const value = await this.client.get(key);

      return value === null ? null : (JSON.parse(value) as T);
    } catch (error) {
      console.error('Route cache read failed; continuing without cache.', error);
      return null;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    try {
      await this.client.setex(key, this.ttlSeconds, JSON.stringify(value));
    } catch (error) {
      console.error('Route cache write failed; returning uncached response.', error);
    }
  }
}

export function createRedisClient(redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379') {
  const client = new Redis(redisUrl, {
    connectTimeout: 2_000,
    maxRetriesPerRequest: 1
  });

  client.on('error', (error: Error) => {
    console.error('Redis connection error.', error.message);
  });

  return client;
}

export function getCacheTtlSeconds(value = process.env.CACHE_TTL_SECONDS) {
  if (value === undefined || value === '') {
    return DEFAULT_CACHE_TTL_SECONDS;
  }

  const ttlSeconds = Number(value);

  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new RangeError('CACHE_TTL_SECONDS must be a positive integer.');
  }

  return ttlSeconds;
}
