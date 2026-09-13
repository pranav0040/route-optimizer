export interface Coordinate {
  lat: number;
  lng: number;
}

export type PathfindingAlgorithm = 'dijkstra' | 'astar';

export interface PointToPointRequest {
  origin: Coordinate;
  destination: Coordinate;
  algorithm: PathfindingAlgorithm;
}

export interface PointToPointResponse {
  distance_m: number;
  duration_s: number;
  path: [number, number][];
  algorithm: PathfindingAlgorithm;
  cached: boolean;
}

export interface OptimizeRequest {
  origin: Coordinate;
  stops: Coordinate[];
}

export interface OptimizedRouteResponse {
  optimized_order: number[];
  total_distance_m: number;
  total_duration_s: number;
  naive_distance_m: number;
  naive_duration_s?: number;
  improvement_pct: number;
  cached: boolean;
  optimized_path?: [number, number][];
  naive_path?: [number, number][];
}

export interface QueuedJobResponse {
  job_id: string;
  status: 'queued';
  cached: boolean;
}

export type OptimizeResponse = OptimizedRouteResponse | QueuedJobResponse;

export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface JobStatusResponse {
  job_id: string;
  status: JobStatus;
  route_id?: string;
  error_reason?: string;
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

export function isQueuedJob(response: OptimizeResponse): response is QueuedJobResponse {
  return 'job_id' in response;
}
