import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { of } from 'rxjs';

import type { SavedRouteResponse } from '../../models/api.models';
import { ApiService } from '../../services/api.service';
import { RouteStateService } from '../../services/route-state.service';
import { JobStatusComponent } from './job-status';

describe('JobStatusComponent', () => {
  let api: jasmine.SpyObj<ApiService>;

  beforeEach(async () => {
    api = jasmine.createSpyObj<ApiService>('ApiService', ['pollJobUntilComplete', 'getRoute']);

    await TestBed.configureTestingModule({
      imports: [JobStatusComponent],
      providers: [provideRouter([]), { provide: ApiService, useValue: api }],
    }).compileComponents();
  });

  it('loads a saved route into the builder and navigates there', () => {
    const savedRoute: SavedRouteResponse = {
      route_id: '11111111-1111-4111-8111-111111111111',
      origin: { lat: 12.9716, lng: 77.5946 },
      stops: [
        { lat: 12.9611, lng: 77.6387 },
        { lat: 12.9352, lng: 77.6146 },
      ],
      optimized_order: [1, 0],
      optimized_path: [
        [12.9716, 77.5946],
        [12.9352, 77.6146],
      ],
      total_distance_m: 11_150,
      total_duration_s: 803,
      naive_distance_m: 12_080,
      naive_duration_s: 870,
      improvement_pct: 7.7,
      cached: true,
      created_at: '2026-09-21T00:00:00.000Z',
    };
    api.getRoute.and.returnValue(of(savedRoute));
    const router = TestBed.inject(Router);
    const navigate = spyOn(router, 'navigate').and.resolveTo(true);
    const fixture = TestBed.createComponent(JobStatusComponent);
    const component = fixture.componentInstance as unknown as {
      loadRoute(routeId: string): void;
    };

    fixture.detectChanges();
    component.loadRoute(savedRoute.route_id);

    const routeState = TestBed.inject(RouteStateService);

    expect(api.getRoute).toHaveBeenCalledOnceWith(savedRoute.route_id);
    expect(routeState.submittedRequest()).toEqual({
      origin: savedRoute.origin,
      stops: savedRoute.stops,
    });
    expect(routeState.currentRouteResult()).toEqual(savedRoute);
    expect(navigate).toHaveBeenCalledOnceWith(['/']);
  });
});
