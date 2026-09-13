import { Injectable, signal } from '@angular/core';

import type {
  Coordinate,
  JobStatusResponse,
  OptimizeRequest,
  OptimizedRouteResponse,
  QueuedJobResponse,
} from '../models/api.models';

export interface CoordinateDraft {
  lat: string;
  lng: string;
}

export interface StopDraft extends CoordinateDraft {
  id: number;
}

export type BuilderResult = OptimizedRouteResponse | QueuedJobResponse | JobStatusResponse;

@Injectable({ providedIn: 'root' })
export class RouteStateService {
  private nextStopId = 3;

  readonly origin = signal<CoordinateDraft>({ lat: '12.9716', lng: '77.5946' });
  readonly stops = signal<StopDraft[]>([
    { id: 1, lat: '12.9611', lng: '77.6387' },
    { id: 2, lat: '12.9352', lng: '77.6146' },
  ]);
  readonly submittedRequest = signal<OptimizeRequest | null>(null);
  readonly currentRouteResult = signal<BuilderResult | null>(null);
  readonly loading = signal(false);
  readonly errorMessage = signal<string | null>(null);

  addEmptyStop() {
    if (this.stops().length >= 25) {
      return;
    }

    this.stops.update((stops) => [...stops, { id: this.nextStopId++, lat: '', lng: '' }]);
    this.invalidateRoute();
  }

  addCoordinateStop(coordinate: Coordinate) {
    if (this.stops().length >= 25) {
      return;
    }

    this.stops.update((stops) => [
      ...stops,
      {
        id: this.nextStopId++,
        lat: coordinate.lat.toFixed(6),
        lng: coordinate.lng.toFixed(6),
      },
    ]);
    this.invalidateRoute();
  }

  removeStop(id: number) {
    this.stops.update((stops) => stops.filter((stop) => stop.id !== id));
    this.invalidateRoute();
  }

  updateOrigin(field: keyof CoordinateDraft, value: string) {
    this.origin.update((origin) => ({ ...origin, [field]: value }));
    this.invalidateRoute();
  }

  updateStop(id: number, field: keyof CoordinateDraft, value: string) {
    this.stops.update((stops) =>
      stops.map((stop) => (stop.id === id ? { ...stop, [field]: value } : stop)),
    );
    this.invalidateRoute();
  }

  beginRequest(request: OptimizeRequest) {
    this.submittedRequest.set(request);
    this.currentRouteResult.set(null);
    this.errorMessage.set(null);
    this.loading.set(true);
  }

  private invalidateRoute() {
    this.submittedRequest.set(null);
    this.currentRouteResult.set(null);
  }
}
