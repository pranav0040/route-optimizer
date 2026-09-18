import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin, map, of, switchMap, throwError, type Observable } from 'rxjs';

import {
  isQueuedJob,
  type Coordinate,
  type GeocodeResponse,
  type JobStatusResponse,
  type OptimizedRouteResponse,
  type QueuedJobResponse,
} from '../../models/api.models';
import { ApiService } from '../../services/api.service';
import {
  type BuilderResult,
  type CoordinateDraft,
  RouteStateService,
  type LocationInputMode,
} from '../../services/route-state.service';
import { RouteMapComponent } from '../route-map/route-map';

@Component({
  selector: 'app-route-builder',
  imports: [FormsModule, RouterLink, RouteMapComponent],
  templateUrl: './route-builder.html',
  styleUrl: './route-builder.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RouteBuilderComponent {
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly routeState = inject(RouteStateService);
  private originSearchTimer?: ReturnType<typeof setTimeout>;
  private readonly stopSearchTimers = new Map<number, ReturnType<typeof setTimeout>>();

  protected readonly origin = this.routeState.origin;
  protected readonly stops = this.routeState.stops;
  protected readonly currentRouteResult = this.routeState.currentRouteResult;
  protected readonly loading = this.routeState.loading;
  protected readonly errorMessage = this.routeState.errorMessage;
  protected readonly stopCount = computed(() => this.stops().length);
  protected readonly usesAsyncProcessing = computed(() => this.stopCount() > 15);
  protected readonly resolvingAddresses = signal(false);
  protected readonly originSuggestions = signal<GeocodeResponse[]>([]);
  protected readonly stopSuggestions = signal<Record<number, GeocodeResponse[]>>({});
  protected readonly searchingOrigin = signal(false);
  protected readonly searchingStopId = signal<number | null>(null);
  protected readonly originSearchError = signal<string | null>(null);
  protected readonly stopSearchErrors = signal<Record<number, string>>({});

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.clearOriginSearchTimer();
      this.stopSearchTimers.forEach((timer) => clearTimeout(timer));
    });
  }

  protected addStop() {
    this.routeState.addEmptyStop();
  }

  protected removeStop(id: number) {
    this.clearStopSearchTimer(id);
    this.routeState.removeStop(id);
    this.stopSuggestions.update((suggestions) => omitKey(suggestions, id));
    this.stopSearchErrors.update((errors) => omitKey(errors, id));
  }

  protected setOriginInputMode(inputMode: LocationInputMode) {
    this.clearOriginSearchTimer();
    this.routeState.setOriginInputMode(inputMode);
    this.originSuggestions.set([]);
    this.originSearchError.set(null);
  }

  protected setStopInputMode(id: number, inputMode: LocationInputMode) {
    this.clearStopSearchTimer(id);
    this.routeState.setStopInputMode(id, inputMode);
    this.stopSuggestions.update((suggestions) => omitKey(suggestions, id));
    this.stopSearchErrors.update((errors) => omitKey(errors, id));
  }

  protected updateOriginCoordinate(field: 'lat' | 'lng', value: string) {
    this.routeState.updateOriginCoordinate(field, value);
  }

  protected updateStopCoordinate(id: number, field: 'lat' | 'lng', value: string) {
    this.routeState.updateStopCoordinate(id, field, value);
  }

  protected updateOriginAddress(value: string) {
    this.routeState.updateOriginAddress(value);
    this.originSuggestions.set([]);
    this.originSearchError.set(null);
    this.scheduleOriginSearch(value);
  }

  protected updateStopAddress(id: number, value: string) {
    this.routeState.updateStopAddress(id, value);
    this.stopSuggestions.update((suggestions) => omitKey(suggestions, id));
    this.stopSearchErrors.update((errors) => omitKey(errors, id));
    this.scheduleStopSearch(id, value);
  }

  protected searchOriginAddress() {
    this.clearOriginSearchTimer();
    const address = this.origin().address.trim();

    if (address.length < 3) {
      this.originSearchError.set('Enter at least 3 characters to search.');
      return;
    }

    this.searchingOrigin.set(true);
    this.originSearchError.set(null);
    this.originSuggestions.set([]);
    this.api
      .searchAddressSuggestions(address)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ suggestions }) => {
          if (this.origin().address.trim() !== address) {
            return;
          }

          this.originSuggestions.set(suggestions);
          this.searchingOrigin.set(false);

          if (suggestions.length === 0) {
            this.originSearchError.set('No matching addresses were found in the map area.');
          }
        },
        error: (error: unknown) => {
          this.originSearchError.set(this.addressSearchError(error));
          this.searchingOrigin.set(false);
        },
      });
  }

  protected searchStopAddress(id: number) {
    this.clearStopSearchTimer(id);
    const stop = this.stops().find((candidate) => candidate.id === id);
    const address = stop?.address.trim() ?? '';

    if (address.length < 3) {
      this.stopSearchErrors.update((errors) => ({
        ...errors,
        [id]: 'Enter at least 3 characters to search.',
      }));
      return;
    }

    this.searchingStopId.set(id);
    this.stopSearchErrors.update((errors) => omitKey(errors, id));
    this.stopSuggestions.update((suggestions) => omitKey(suggestions, id));
    this.api
      .searchAddressSuggestions(address)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ suggestions }) => {
          if (
            this.stops()
              .find((candidate) => candidate.id === id)
              ?.address.trim() !== address
          ) {
            return;
          }

          this.stopSuggestions.update((current) => ({ ...current, [id]: suggestions }));
          this.searchingStopId.set(null);

          if (suggestions.length === 0) {
            this.stopSearchErrors.update((errors) => ({
              ...errors,
              [id]: 'No matching addresses were found in the map area.',
            }));
          }
        },
        error: (error: unknown) => {
          this.stopSearchErrors.update((errors) => ({
            ...errors,
            [id]: this.addressSearchError(error),
          }));
          this.searchingStopId.set(null);
        },
      });
  }

  protected selectOriginSuggestion(suggestion: GeocodeResponse) {
    this.routeState.setResolvedOrigin(suggestion, suggestion.display_name);
    this.originSuggestions.set([]);
    this.originSearchError.set(null);
  }

  protected selectStopSuggestion(id: number, suggestion: GeocodeResponse) {
    this.routeState.setResolvedStop(id, suggestion, suggestion.display_name);
    this.stopSuggestions.update((suggestions) => omitKey(suggestions, id));
    this.stopSearchErrors.update((errors) => omitKey(errors, id));
  }

  protected submit() {
    const stopDrafts = this.stops();

    if (stopDrafts.length < 2 || stopDrafts.length > 25) {
      this.errorMessage.set('Add between 2 and 25 stops before optimizing.');
      return;
    }

    this.errorMessage.set(null);
    this.loading.set(true);
    this.resolvingAddresses.set(
      this.origin().inputMode === 'address' ||
        stopDrafts.some((stop) => stop.inputMode === 'address'),
    );

    forkJoin({
      origin: this.resolveLocation(this.origin(), 'starting point'),
      stops: forkJoin(
        stopDrafts.map((stop, index) => this.resolveLocation(stop, `stop ${index + 1}`)),
      ),
    })
      .pipe(
        switchMap(({ origin, stops }) => {
          const request = {
            origin: origin.coordinate,
            stops: stops.map(({ coordinate }) => coordinate),
          };

          if (origin.geocoded) {
            this.routeState.setResolvedOrigin(origin.coordinate, origin.displayName);
          }

          stops.forEach((stop, index) => {
            if (stop.geocoded) {
              this.routeState.setResolvedStop(
                stopDrafts[index].id,
                stop.coordinate,
                stop.displayName,
              );
            }
          });

          this.resolvingAddresses.set(false);
          this.routeState.beginRequest(request);
          return this.api.optimize(request);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (response) => {
          this.currentRouteResult.set(response);

          if (isQueuedJob(response)) {
            this.pollJob(response.job_id);
          } else {
            this.loading.set(false);
          }
        },
        error: (error: unknown) => this.handleError(error),
      });
  }

  protected isRouteResult(result: BuilderResult): result is OptimizedRouteResponse {
    return 'optimized_order' in result;
  }

  protected isJobResult(result: BuilderResult): result is QueuedJobResponse | JobStatusResponse {
    return 'job_id' in result;
  }

  protected formatDuration(seconds: number) {
    const minutes = Math.round(seconds / 60);

    return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }

  protected stopDisplayLabel(stopIndex: number) {
    const stop = this.stops()[stopIndex];

    if (!stop) {
      return `Stop ${stopIndex + 1}`;
    }

    const address = stop.resolvedAddress || stop.address.trim();
    return address || `${stop.lat}, ${stop.lng}`;
  }

  private pollJob(jobId: string) {
    this.api
      .pollJobUntilComplete(jobId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (job) => {
          this.currentRouteResult.set(job);
          this.loading.set(false);

          if (job.status === 'failed') {
            this.errorMessage.set(job.error_reason ?? 'Route optimization failed.');
          }
        },
        error: (error: unknown) => this.handleError(error),
      });
  }

  private handleError(error: unknown) {
    const message = this.errorText(error);

    this.errorMessage.set(message ?? 'Could not optimize this route. Please try again.');
    this.resolvingAddresses.set(false);
    this.loading.set(false);
  }

  private resolveLocation(draft: CoordinateDraft, label: string): Observable<ResolvedLocation> {
    if (draft.inputMode === 'coordinates') {
      const coordinate = parseCoordinate(draft);

      return coordinate
        ? of({ coordinate, geocoded: false, displayName: '' })
        : throwError(
            () => new Error(`Enter valid latitude and longitude values for the ${label}.`),
          );
    }

    const address = draft.address.trim();

    if (address.length < 3) {
      return throwError(() => new Error(`Enter an address for the ${label}.`));
    }

    const selectedCoordinate = parseCoordinate(draft);

    if (draft.resolvedAddress === address && selectedCoordinate) {
      return of({ coordinate: selectedCoordinate, geocoded: false, displayName: address });
    }

    return this.api.geocodeAddress(address).pipe(
      map((result) => ({
        coordinate: { lat: result.lat, lng: result.lng },
        geocoded: true,
        displayName: result.display_name,
      })),
    );
  }

  private addressSearchError(error: unknown) {
    return this.errorText(error) ?? 'Could not search for that address. Please try again.';
  }

  private errorText(error: unknown) {
    return error instanceof HttpErrorResponse
      ? (error.error?.error?.message as string | undefined)
      : error instanceof Error
        ? error.message
        : undefined;
  }

  private scheduleOriginSearch(value: string) {
    this.clearOriginSearchTimer();

    if (value.trim().length < 3) {
      return;
    }

    this.originSearchTimer = setTimeout(() => this.searchOriginAddress(), 450);
  }

  private scheduleStopSearch(id: number, value: string) {
    this.clearStopSearchTimer(id);

    if (value.trim().length < 3) {
      return;
    }

    this.stopSearchTimers.set(
      id,
      setTimeout(() => this.searchStopAddress(id), 450),
    );
  }

  private clearOriginSearchTimer() {
    if (this.originSearchTimer) {
      clearTimeout(this.originSearchTimer);
      this.originSearchTimer = undefined;
    }
  }

  private clearStopSearchTimer(id: number) {
    const timer = this.stopSearchTimers.get(id);

    if (timer) {
      clearTimeout(timer);
      this.stopSearchTimers.delete(id);
    }
  }
}

function omitKey<T>(record: Record<number, T>, key: number) {
  const next = { ...record };

  delete next[key];
  return next;
}

interface ResolvedLocation {
  coordinate: Coordinate;
  geocoded: boolean;
  displayName: string;
}

function parseCoordinate(draft: CoordinateDraft): Coordinate | null {
  const lat = Number(draft.lat);
  const lng = Number(draft.lng);

  if (
    draft.lat.trim() === '' ||
    draft.lng.trim() === '' ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    return null;
  }

  return { lat, lng };
}
