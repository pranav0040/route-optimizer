import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import {
  isQueuedJob,
  type Coordinate,
  type JobStatusResponse,
  type OptimizedRouteResponse,
  type QueuedJobResponse,
} from '../../models/api.models';
import { ApiService } from '../../services/api.service';
import {
  type BuilderResult,
  type CoordinateDraft,
  RouteStateService,
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

  protected readonly origin = this.routeState.origin;
  protected readonly stops = this.routeState.stops;
  protected readonly currentRouteResult = this.routeState.currentRouteResult;
  protected readonly loading = this.routeState.loading;
  protected readonly errorMessage = this.routeState.errorMessage;
  protected readonly stopCount = computed(() => this.stops().length);
  protected readonly usesAsyncProcessing = computed(() => this.stopCount() > 15);

  protected addStop() {
    this.routeState.addEmptyStop();
  }

  protected removeStop(id: number) {
    this.routeState.removeStop(id);
  }

  protected updateOrigin(field: keyof CoordinateDraft, value: string) {
    this.routeState.updateOrigin(field, value);
  }

  protected updateStop(id: number, field: keyof CoordinateDraft, value: string) {
    this.routeState.updateStop(id, field, value);
  }

  protected submit() {
    const origin = parseCoordinate(this.origin());
    const stops = this.stops().map(parseCoordinate);

    if (!origin || stops.some((stop) => stop === null)) {
      this.errorMessage.set('Enter valid latitude and longitude values for every location.');
      return;
    }

    if (stops.length < 2 || stops.length > 25) {
      this.errorMessage.set('Add between 2 and 25 stops before optimizing.');
      return;
    }

    this.routeState.beginRequest({ origin, stops: stops as Coordinate[] });
    this.api
      .optimize({ origin, stops: stops as Coordinate[] })
      .pipe(takeUntilDestroyed(this.destroyRef))
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
    const message =
      error instanceof HttpErrorResponse
        ? (error.error?.error?.message as string | undefined)
        : undefined;

    this.errorMessage.set(message ?? 'Could not optimize this route. Please try again.');
    this.loading.set(false);
  }
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
