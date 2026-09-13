import { HttpClient } from '@angular/common/http';
import { inject, Injectable, InjectionToken } from '@angular/core';
import { EMPTY, expand, filter, switchMap, take, timer } from 'rxjs';

import type {
  JobStatusResponse,
  OptimizeRequest,
  OptimizeResponse,
  PointToPointRequest,
  PointToPointResponse,
} from '../models/api.models';

export const API_BASE_URL = new InjectionToken<string>('API_BASE_URL', {
  providedIn: 'root',
  factory: () => {
    if (typeof window === 'undefined') {
      return 'http://localhost:3000/api';
    }

    return (
      window.__ROUTE_OPTIMIZER_CONFIG__?.apiBaseUrl?.replace(/\/$/, '') ||
      'http://localhost:3000/api'
    );
  },
});

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(API_BASE_URL);

  pointToPoint(request: PointToPointRequest) {
    return this.http.post<PointToPointResponse>(`${this.baseUrl}/routes/point-to-point`, request);
  }

  optimize(request: OptimizeRequest) {
    return this.http.post<OptimizeResponse>(`${this.baseUrl}/routes/optimize`, request);
  }

  getJob(jobId: string) {
    return this.http.get<JobStatusResponse>(`${this.baseUrl}/jobs/${encodeURIComponent(jobId)}`);
  }

  pollJobUntilComplete(jobId: string, intervalMs = 1_000) {
    return this.getJob(jobId).pipe(
      expand((job) =>
        isTerminal(job) ? EMPTY : timer(intervalMs).pipe(switchMap(() => this.getJob(jobId))),
      ),
      filter(isTerminal),
      take(1),
    );
  }
}

function isTerminal(job: JobStatusResponse) {
  return job.status === 'completed' || job.status === 'failed';
}
