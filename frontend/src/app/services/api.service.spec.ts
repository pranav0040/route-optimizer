import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { fakeAsync, TestBed, tick } from '@angular/core/testing';

import type {
  JobStatusResponse,
  OptimizeRequest,
  OptimizeResponse,
  PointToPointRequest,
  PointToPointResponse,
} from '../models/api.models';
import { API_BASE_URL, ApiService } from './api.service';

describe('ApiService', () => {
  let service: ApiService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        ApiService,
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    });
    service = TestBed.inject(ApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('posts a typed point-to-point request', () => {
    const body: PointToPointRequest = {
      origin: { lat: 12.9716, lng: 77.5946 },
      destination: { lat: 12.9352, lng: 77.6146 },
      algorithm: 'astar',
    };
    const expected: PointToPointResponse = {
      distance_m: 8420,
      duration_s: 960,
      path: [
        [12.9716, 77.5946],
        [12.9352, 77.6146],
      ],
      algorithm: 'astar',
      cached: false,
    };
    let actual: PointToPointResponse | undefined;

    service.pointToPoint(body).subscribe((response) => (actual = response));
    const request = http.expectOne('/api/routes/point-to-point');

    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual(body);
    request.flush(expected);
    expect(actual).toEqual(expected);
  });

  it('posts a typed optimization request', () => {
    const body: OptimizeRequest = {
      origin: { lat: 12.9716, lng: 77.5946 },
      stops: [
        { lat: 12.9611, lng: 77.6387 },
        { lat: 12.9352, lng: 77.6146 },
      ],
    };
    const expected: OptimizeResponse = {
      optimized_order: [1, 0],
      total_distance_m: 15230,
      total_duration_s: 1740,
      naive_distance_m: 18900,
      improvement_pct: 19.4,
      cached: false,
    };

    service.optimize(body).subscribe((response) => expect(response).toEqual(expected));
    const request = http.expectOne('/api/routes/optimize');

    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual(body);
    request.flush(expected);
  });

  it('polls a queued job until it reaches a terminal state', fakeAsync(() => {
    let result: JobStatusResponse | undefined;

    service.pollJobUntilComplete('job/123', 250).subscribe((response) => (result = response));
    const queued = http.expectOne('/api/jobs/job%2F123');

    queued.flush({ job_id: 'job/123', status: 'queued' } satisfies JobStatusResponse);
    tick(250);
    const processing = http.expectOne('/api/jobs/job%2F123');
    processing.flush({ job_id: 'job/123', status: 'processing' } satisfies JobStatusResponse);
    tick(250);
    const completed = http.expectOne('/api/jobs/job%2F123');
    completed.flush({
      job_id: 'job/123',
      status: 'completed',
      route_id: 'route-456',
    } satisfies JobStatusResponse);

    expect(result).toEqual({
      job_id: 'job/123',
      status: 'completed',
      route_id: 'route-456',
    });
  }));
});
