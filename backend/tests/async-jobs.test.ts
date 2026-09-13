import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { optimizeMultiStopRoute, type OptimizedRoute } from '../src/algorithms/route-optimizer.js';
import { createApp } from '../src/app.js';
import type { NearestNode } from '../src/db/nearest-node.js';
import { type GraphEdge, type GraphNode, RoadGraph } from '../src/graph/road-graph.js';
import {
  processOptimizationJob,
  type OptimizationProcessorDependencies
} from '../src/jobs/optimization-processor.js';
import type {
  JobRepository,
  JobStatusEvent,
  JobStatusPublisher,
  JobStatusRecord,
  OptimizationJobData,
  OptimizationJobQueue
} from '../src/jobs/types.js';

describe('asynchronous optimization jobs', () => {
  it('submits, processes, polls, and persists the same result as direct computation', async () => {
    const repository = new MemoryJobRepository();
    const publisher = new MemoryStatusPublisher();
    const optimizeRoute = vi.fn(optimizeMultiStopRoute);
    const cache = {
      async get() {
        return null;
      },
      set: vi.fn(async () => undefined)
    };
    const dependencies: OptimizationProcessorDependencies = {
      graph,
      repository,
      publisher,
      cache,
      snapCoordinate,
      optimizeRoute
    };
    const jobQueue = new InProcessJobQueue(repository, dependencies);
    const app = createApp({ graph, snapCoordinate, jobQueue, jobRepository: repository });
    const body = {
      origin: { lat: 0, lng: 0 },
      stops: Array.from({ length: 16 }, () => ({ lat: 0.001, lng: 0 }))
    };

    const submission = await request(app).post('/api/routes/optimize').send(body);

    expect(submission.status).toBe(202);
    expect(submission.body).toMatchObject({ status: 'queued', cached: false });
    expect(submission.body.job_id).toEqual(expect.any(String));

    const completed = await pollUntilTerminal(app, submission.body.job_id as string);
    const persisted = repository.routes.get(completed.body.route_id as string);
    const direct = optimizeMultiStopRoute(
      { originNodeId: 1, stopNodeIds: Array.from({ length: 16 }, () => 2) },
      graph
    );

    if ('status' in direct) {
      throw new Error('Expected direct optimization to succeed.');
    }

    expect(completed.body).toEqual({
      job_id: submission.body.job_id,
      status: 'completed',
      route_id: expect.any(String)
    });
    expect(persisted?.result).toEqual(direct);
    expect(optimizeRoute).toHaveBeenCalledTimes(1);
    expect(cache.set).toHaveBeenCalledWith(
      expect.stringMatching(/^route-cache:v1:/),
      expect.objectContaining({ optimized_order: direct.optimizedOrder, cached: false })
    );
    expect(publisher.events.map((event) => event.status)).toEqual(['processing', 'completed']);
  });

  it('surfaces a background failure reason from the status endpoint', async () => {
    const repository = new MemoryJobRepository();
    const publisher = new MemoryStatusPublisher();
    const jobQueue = new InProcessJobQueue(repository, {
      graph,
      repository,
      publisher,
      snapCoordinate
    });
    const app = createApp({ graph, snapCoordinate, jobQueue, jobRepository: repository });
    const body = {
      origin: { lat: 50, lng: 50 },
      stops: Array.from({ length: 16 }, () => ({ lat: 0.001, lng: 0 }))
    };

    const submission = await request(app).post('/api/routes/optimize').send(body);
    const failed = await pollUntilTerminal(app, submission.body.job_id as string);

    expect(submission.status).toBe(202);
    expect(failed.body).toEqual({
      job_id: submission.body.job_id,
      status: 'failed',
      error_reason: 'origin could not be matched within the configured snap radius.'
    });
  });
});

class InProcessJobQueue implements OptimizationJobQueue {
  constructor(
    private readonly repository: JobRepository,
    private readonly dependencies: OptimizationProcessorDependencies
  ) {}

  async enqueue(data: OptimizationJobData) {
    const jobId = randomUUID();

    await this.repository.createJob(jobId, data);
    setImmediate(() => {
      void processOptimizationJob(jobId, data, this.dependencies).catch(async (error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);

        await this.repository.failJob(jobId, reason);
        await this.dependencies.publisher.publish({
          jobId,
          status: 'failed',
          routeId: null,
          errorReason: reason
        });
      });
    });
    return jobId;
  }
}

class MemoryJobRepository implements JobRepository {
  readonly jobs = new Map<string, JobStatusRecord>();
  readonly routes = new Map<string, { data: OptimizationJobData; result: OptimizedRoute }>();

  async createJob(jobId: string, data: OptimizationJobData) {
    void data;
    this.jobs.set(jobId, {
      jobId,
      status: 'queued',
      routeId: null,
      errorReason: null
    });
  }

  async getJob(jobId: string) {
    return this.jobs.get(jobId) ?? null;
  }

  async markProcessing(jobId: string) {
    this.update(jobId, { status: 'processing', errorReason: null });
  }

  async markQueued(jobId: string) {
    this.update(jobId, { status: 'queued' });
  }

  async completeJob(jobId: string, data: OptimizationJobData, result: OptimizedRoute) {
    const routeId = randomUUID();

    this.routes.set(routeId, { data, result });
    this.update(jobId, {
      status: 'completed',
      routeId,
      errorReason: null
    });
    return routeId;
  }

  async failJob(jobId: string, reason: string) {
    this.update(jobId, { status: 'failed', errorReason: reason });
  }

  private update(jobId: string, changes: Partial<JobStatusRecord>) {
    const current = this.jobs.get(jobId);

    if (!current) {
      throw new Error(`Unknown test job ${jobId}`);
    }

    this.jobs.set(jobId, { ...current, ...changes });
  }
}

class MemoryStatusPublisher implements JobStatusPublisher {
  readonly events: JobStatusEvent[] = [];

  async publish(event: JobStatusEvent) {
    this.events.push(event);
  }
}

async function pollUntilTerminal(app: ReturnType<typeof createApp>, jobId: string) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await request(app).get(`/api/jobs/${jobId}`);

    if (response.body.status === 'completed' || response.body.status === 'failed') {
      return response;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error(`Job ${jobId} did not reach a terminal state.`);
}

const graph = new RoadGraph([node(1, 0), node(2, 0.001)], [edge(1, 2, 100), edge(2, 1, 100)]);

async function snapCoordinate(lat: number, lng: number): Promise<NearestNode | null> {
  const matchingNode = graph
    .getNodeIds()
    .map((id) => graph.getNode(id))
    .find((candidate) => candidate?.lat === lat && candidate.lng === lng);

  return matchingNode ? { ...matchingNode, distanceM: 0 } : null;
}

function node(id: number, lat: number): GraphNode {
  return { id, lat, lng: 0 };
}

function edge(fromNodeId: number, toNodeId: number, distanceM: number): GraphEdge {
  return { fromNodeId, toNodeId, distanceM };
}
