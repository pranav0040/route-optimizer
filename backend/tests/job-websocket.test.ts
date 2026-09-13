import { createServer } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, type RawData, type WebSocketServer } from 'ws';

import { createApp } from '../src/app.js';
import type { JobStatusListener, JobStatusSubscriber } from '../src/jobs/status-events.js';
import type { JobRepository, JobStatusRecord } from '../src/jobs/types.js';
import { attachJobStatusWebSocket } from '../src/websocket/job-status-websocket.js';

describe('job status WebSocket', () => {
  let socket: WebSocket | undefined;
  let webSocketServer: WebSocketServer | undefined;
  let httpServer: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    socket?.terminate();
    webSocketServer?.close();

    if (httpServer) {
      await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
    }
  });

  it('pushes status changes only through the subscribed job room', async () => {
    const jobId = '11111111-1111-4111-8111-111111111111';
    const repository = new StaticJobRepository({
      jobId,
      status: 'processing',
      routeId: null,
      errorReason: null
    });
    const subscriber = new MemoryStatusSubscriber();
    httpServer = createServer(createApp({ jobRepository: repository }));
    webSocketServer = await attachJobStatusWebSocket(httpServer, repository, subscriber);
    await new Promise<void>((resolve) => httpServer?.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();

    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP address for the WebSocket test server.');
    }

    socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws/jobs/${jobId}`);
    const initial = JSON.parse(await nextMessage(socket)) as unknown;
    const completedMessage = nextMessage(socket);

    subscriber.emit({
      jobId,
      status: 'completed',
      routeId: '22222222-2222-4222-8222-222222222222',
      errorReason: null
    });

    expect(initial).toEqual({ job_id: jobId, status: 'processing' });
    expect(JSON.parse(await completedMessage)).toEqual({
      job_id: jobId,
      status: 'completed',
      route_id: '22222222-2222-4222-8222-222222222222'
    });
  });
});

class MemoryStatusSubscriber implements JobStatusSubscriber {
  private listener: JobStatusListener | undefined;

  async subscribe(listener: JobStatusListener) {
    this.listener = listener;
  }

  emit(event: Parameters<JobStatusListener>[0]) {
    this.listener?.(event);
  }
}

class StaticJobRepository implements JobRepository {
  constructor(private readonly job: JobStatusRecord) {}

  async createJob() {}

  async getJob(jobId: string) {
    return jobId === this.job.jobId ? this.job : null;
  }

  async markProcessing() {}

  async markQueued() {}

  async completeJob() {
    return 'unused';
  }

  async failJob() {}
}

function nextMessage(socket: WebSocket) {
  return new Promise<string>((resolve, reject) => {
    socket.once('message', (data: RawData) => resolve(data.toString()));
    socket.once('error', reject);
  });
}
