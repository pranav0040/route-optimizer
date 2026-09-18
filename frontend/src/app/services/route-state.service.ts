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
  address: string;
  inputMode: LocationInputMode;
  resolvedAddress: string;
}

export type LocationInputMode = 'coordinates' | 'address';

export interface StopDraft extends CoordinateDraft {
  id: number;
}

export type BuilderResult = OptimizedRouteResponse | QueuedJobResponse | JobStatusResponse;

@Injectable({ providedIn: 'root' })
export class RouteStateService {
  private nextStopId = 3;

  readonly origin = signal<CoordinateDraft>({
    lat: '12.9716',
    lng: '77.5946',
    address: '',
    inputMode: 'coordinates',
    resolvedAddress: '',
  });
  readonly stops = signal<StopDraft[]>([
    {
      id: 1,
      lat: '12.9611',
      lng: '77.6387',
      address: '',
      inputMode: 'coordinates',
      resolvedAddress: '',
    },
    {
      id: 2,
      lat: '12.9352',
      lng: '77.6146',
      address: '',
      inputMode: 'coordinates',
      resolvedAddress: '',
    },
  ]);
  readonly submittedRequest = signal<OptimizeRequest | null>(null);
  readonly currentRouteResult = signal<BuilderResult | null>(null);
  readonly loading = signal(false);
  readonly errorMessage = signal<string | null>(null);

  addEmptyStop() {
    if (this.stops().length >= 25) {
      return;
    }

    this.stops.update((stops) => [
      ...stops,
      {
        id: this.nextStopId++,
        lat: '',
        lng: '',
        address: '',
        inputMode: 'coordinates',
        resolvedAddress: '',
      },
    ]);
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
        address: '',
        inputMode: 'coordinates',
        resolvedAddress: '',
      },
    ]);
    this.invalidateRoute();
  }

  addResolvedStop(coordinate: Coordinate, resolvedAddress: string) {
    if (this.stops().length >= 25) {
      return;
    }

    this.stops.update((stops) => [
      ...stops,
      {
        id: this.nextStopId++,
        lat: coordinate.lat.toFixed(6),
        lng: coordinate.lng.toFixed(6),
        address: resolvedAddress,
        inputMode: 'address',
        resolvedAddress,
      },
    ]);
    this.invalidateRoute();
  }

  removeStop(id: number) {
    this.stops.update((stops) => stops.filter((stop) => stop.id !== id));
    this.invalidateRoute();
  }

  setOriginInputMode(inputMode: LocationInputMode) {
    this.origin.update((origin) => ({ ...origin, inputMode }));
    this.invalidateRoute();
  }

  setStopInputMode(id: number, inputMode: LocationInputMode) {
    this.stops.update((stops) =>
      stops.map((stop) => (stop.id === id ? { ...stop, inputMode } : stop)),
    );
    this.invalidateRoute();
  }

  updateOriginCoordinate(field: 'lat' | 'lng', value: string) {
    this.origin.update((origin) => ({ ...origin, [field]: value, resolvedAddress: '' }));
    this.invalidateRoute();
  }

  updateStopCoordinate(id: number, field: 'lat' | 'lng', value: string) {
    this.stops.update((stops) =>
      stops.map((stop) =>
        stop.id === id ? { ...stop, [field]: value, resolvedAddress: '' } : stop,
      ),
    );
    this.invalidateRoute();
  }

  updateOriginAddress(address: string) {
    this.origin.update((origin) => ({ ...origin, address, resolvedAddress: '' }));
    this.invalidateRoute();
  }

  updateStopAddress(id: number, address: string) {
    this.stops.update((stops) =>
      stops.map((stop) => (stop.id === id ? { ...stop, address, resolvedAddress: '' } : stop)),
    );
    this.invalidateRoute();
  }

  setResolvedOrigin(coordinate: Coordinate, resolvedAddress: string) {
    this.origin.update((origin) => ({
      ...origin,
      lat: coordinate.lat.toFixed(6),
      lng: coordinate.lng.toFixed(6),
      address: resolvedAddress,
      resolvedAddress,
    }));
    this.invalidateRoute();
  }

  setResolvedStop(id: number, coordinate: Coordinate, resolvedAddress: string) {
    this.stops.update((stops) =>
      stops.map((stop) =>
        stop.id === id
          ? {
              ...stop,
              lat: coordinate.lat.toFixed(6),
              lng: coordinate.lng.toFixed(6),
              address: resolvedAddress,
              resolvedAddress,
            }
          : stop,
      ),
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
