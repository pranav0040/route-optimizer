import type { OptimizedRoute } from '../algorithms/route-optimizer.js';

export const ROUTE_OPTIMIZATION_QUEUE = 'route-optimization';
export const JOB_STATUS_CHANNEL = 'route-optimizer:job-status';

export interface JobCoordinate {
  lat: number;
  lng: number;
}

export interface OptimizationJobData {
  origin: JobCoordinate;
  stops: JobCoordinate[];
  cacheKey: string;
}

export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface JobStatusRecord {
  jobId: string;
  status: JobStatus;
  routeId: string | null;
  errorReason: string | null;
}

export type JobStatusEvent = JobStatusRecord;

export interface JobRepository {
  createJob(jobId: string, data: OptimizationJobData): Promise<void>;
  getJob(jobId: string): Promise<JobStatusRecord | null>;
  markProcessing(jobId: string): Promise<void>;
  markQueued(jobId: string): Promise<void>;
  completeJob(jobId: string, data: OptimizationJobData, result: OptimizedRoute): Promise<string>;
  failJob(jobId: string, reason: string): Promise<void>;
}

export interface JobStatusPublisher {
  publish(event: JobStatusEvent): Promise<void>;
}

export interface OptimizationJobQueue {
  enqueue(data: OptimizationJobData): Promise<string>;
}
