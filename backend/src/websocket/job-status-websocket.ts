import type { Server } from 'node:http';

import { WebSocket, WebSocketServer } from 'ws';

import type { JobRepository, JobStatusEvent } from '../jobs/types.js';
import type { JobStatusSubscriber } from '../jobs/status-events.js';

const JOB_PATH = /^\/ws\/jobs\/([^/]+)$/;

export async function attachJobStatusWebSocket(
  server: Server,
  repository: JobRepository,
  subscriber: JobStatusSubscriber
) {
  const rooms = new Map<string, Set<WebSocket>>();
  const webSocketServer = new WebSocketServer({ server });

  webSocketServer.on('connection', (socket, request) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const match = JOB_PATH.exec(path);

    if (!match) {
      socket.close(1008, 'Expected /ws/jobs/:job_id');
      return;
    }

    const jobId = decodeURIComponent(match[1]);
    const room = rooms.get(jobId) ?? new Set<WebSocket>();

    room.add(socket);
    rooms.set(jobId, room);
    socket.on('close', () => {
      room.delete(socket);

      if (room.size === 0) {
        rooms.delete(jobId);
      }
    });

    void repository
      .getJob(jobId)
      .then((job) => {
        if (job && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(jobStatusPayload(job)));
        }
      })
      .catch((error: unknown) => {
        console.error(`Could not load WebSocket state for job ${jobId}.`, error);
        socket.close(1011, 'Could not load job status');
      });
  });

  await subscriber.subscribe((event) => {
    const message = JSON.stringify(jobStatusPayload(event));

    for (const socket of rooms.get(event.jobId) ?? []) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(message);
      }
    }
  });

  return webSocketServer;
}

function jobStatusPayload(event: JobStatusEvent) {
  return {
    job_id: event.jobId,
    status: event.status,
    ...(event.routeId ? { route_id: event.routeId } : {}),
    ...(event.errorReason ? { error_reason: event.errorReason } : {})
  };
}
