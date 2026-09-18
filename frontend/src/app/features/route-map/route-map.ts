import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnDestroy,
  ViewChild,
  ViewEncapsulation,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import * as L from 'leaflet';

import type { Coordinate, OptimizeRequest, OptimizedRouteResponse } from '../../models/api.models';
import {
  type CoordinateDraft,
  RouteStateService,
  type StopDraft,
} from '../../services/route-state.service';
import { ApiService } from '../../services/api.service';
import { CARTO_BASEMAP_KEY } from '../../services/runtime-config';

export const VOYAGER_TILE_URL =
  'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
export const BASEMAP_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, ' +
  '&copy; <a href="https://carto.com/attributions">CARTO</a>';

const DEFAULT_CENTER: L.LatLngExpression = [12.9716, 77.5946];
export const SNAP_RADIUS_M = 500;
export const SEARCHABLE_AREA_BOUNDS: L.LatLngBoundsLiteral = [
  [12.8467491, 77.5285614],
  [13.0391168, 77.7420454],
];

@Component({
  selector: 'app-route-map',
  templateUrl: './route-map.html',
  styleUrl: './route-map.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
})
export class RouteMapComponent implements AfterViewInit, OnDestroy {
  @ViewChild('map', { static: true }) private readonly mapElement!: ElementRef<HTMLElement>;

  private readonly routeState = inject(RouteStateService);
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly cartoBasemapKey = inject(CARTO_BASEMAP_KEY);
  private mapInstance?: L.Map;
  private searchableAreaBounds = L.latLngBounds(SEARCHABLE_AREA_BOUNDS);
  private readonly searchableAreaBoundary = L.rectangle(SEARCHABLE_AREA_BOUNDS, {
    color: '#111111',
    weight: 3,
    opacity: 0.9,
    fill: false,
    interactive: false,
    className: 'searchable-area-boundary',
  });
  private readonly draftStopsLayerGroup = L.layerGroup();
  private readonly optimizedLayerGroup = L.layerGroup();
  private readonly naiveLayerGroup = L.layerGroup();
  private optimizedBoundsPoints: L.LatLngExpression[] = [];
  private naiveBoundsPoints: L.LatLngExpression[] = [];

  protected readonly compareMode = signal(false);
  protected readonly snapRadiusM = signal(SNAP_RADIUS_M);
  protected readonly resolvingMapPoint = signal(false);
  protected readonly mapPointMessage = signal<string | null>(null);
  protected readonly routeResult = computed(() => {
    const result = this.routeState.currentRouteResult();
    return result && 'optimized_order' in result ? result : null;
  });
  protected readonly distanceSavedM = computed(() => {
    const result = this.routeResult();
    return result ? Math.max(0, result.naive_distance_m - result.total_distance_m) : 0;
  });
  protected readonly durationSavedS = computed(() => {
    const result = this.routeResult();

    if (!result) {
      return 0;
    }

    const naiveDurationS =
      result.naive_duration_s ??
      (result.total_distance_m > 0
        ? (result.naive_distance_m / result.total_distance_m) * result.total_duration_s
        : result.total_duration_s);

    return Math.max(0, naiveDurationS - result.total_duration_s);
  });

  private readonly renderRouteEffect = effect(() => {
    const request = this.routeState.submittedRequest();
    const result = this.routeResult();

    if (!this.mapInstance) {
      return;
    }

    untracked(() => {
      if (request && result) {
        this.renderRoute(request, result);
      } else {
        this.clearRouteLayers();
      }
    });
  });

  private readonly compareModeEffect = effect(() => {
    const compareMode = this.compareMode();

    if (this.mapInstance) {
      untracked(() => this.syncComparisonLayer(compareMode));
    }
  });

  private readonly renderDraftStopsEffect = effect(() => {
    const origin = this.routeState.origin();
    const stops = this.routeState.stops();
    const hasOptimizedRoute = this.routeResult() !== null;

    if (this.mapInstance) {
      untracked(() =>
        this.renderDraftLocations(
          hasOptimizedRoute ? null : origin,
          hasOptimizedRoute ? [] : stops,
        ),
      );
    }
  });

  ngAfterViewInit() {
    this.mapInstance = L.map(this.mapElement.nativeElement, {
      center: DEFAULT_CENTER,
      zoom: 12,
      zoomControl: true,
    });

    L.tileLayer(createVoyagerTileUrl(this.cartoBasemapKey), {
      attribution: BASEMAP_ATTRIBUTION,
      subdomains: 'abcd',
      minZoom: 0,
      maxZoom: 20,
    }).addTo(this.mapInstance);
    this.searchableAreaBoundary.addTo(this.mapInstance);
    this.draftStopsLayerGroup.addTo(this.mapInstance);
    this.optimizedLayerGroup.addTo(this.mapInstance);
    this.mapInstance.on('click', ({ latlng }: L.LeafletMouseEvent) => this.addStopFromMap(latlng));

    const request = this.routeState.submittedRequest();
    const result = this.routeResult();

    if (request && result) {
      this.renderRoute(request, result);
    } else {
      this.renderDraftLocations(this.routeState.origin(), this.routeState.stops());
    }

    this.loadRoutingCoverage();
  }

  ngOnDestroy() {
    this.mapInstance?.remove();
  }

  protected setCompareMode(enabled: boolean) {
    this.compareMode.set(enabled);
  }

  protected formatDistance(distanceM: number) {
    return `${(distanceM / 1_000).toFixed(1)} km`;
  }

  protected formatMinutes(durationS: number) {
    return `${Math.round(durationS / 60)} min`;
  }

  private addStopFromMap(latlng: L.LatLng) {
    if (!this.searchableAreaBounds.contains(latlng)) {
      this.mapPointMessage.set('Choose a point inside the black searchable-area boundary.');
      return;
    }

    if (this.resolvingMapPoint() || this.routeState.stops().length >= 25) {
      return;
    }

    const coordinate = { lat: latlng.lat, lng: latlng.lng };
    this.resolvingMapPoint.set(true);
    this.mapPointMessage.set('Finding the address for this point…');
    this.api
      .reverseGeocode(coordinate.lat, coordinate.lng)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (result) => {
          this.routeState.addResolvedStop(coordinate, result.display_name);
          this.resolvingMapPoint.set(false);
          this.mapPointMessage.set('Address added to delivery stops.');
        },
        error: () => {
          this.routeState.addCoordinateStop(coordinate);
          this.resolvingMapPoint.set(false);
          this.mapPointMessage.set('No address was found, so the coordinates were added instead.');
        },
      });
  }

  private loadRoutingCoverage() {
    this.api
      .getRoutingCoverage()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ bounds, snap_radius_m: snapRadiusM }) => {
          this.searchableAreaBounds = L.latLngBounds(
            [bounds.south, bounds.west],
            [bounds.north, bounds.east],
          );
          this.searchableAreaBoundary.setBounds(this.searchableAreaBounds);
          this.snapRadiusM.set(snapRadiusM);

          if (this.routeResult()) {
            this.fitVisibleBounds(this.compareMode());
          } else {
            this.renderDraftLocations(this.routeState.origin(), this.routeState.stops());
          }
        },
        error: () => {
          // Keep the built-in coverage fallback when metadata is temporarily unavailable.
        },
      });
  }

  private renderRoute(request: OptimizeRequest, result: OptimizedRouteResponse) {
    this.optimizedLayerGroup.clearLayers();
    this.naiveLayerGroup.clearLayers();

    const optimizedStops = result.optimized_order
      .map((inputIndex) => ({ inputIndex, coordinate: request.stops[inputIndex] }))
      .filter(
        (stop): stop is { inputIndex: number; coordinate: Coordinate } =>
          stop.coordinate !== undefined,
      );
    const optimizedWaypoints = [request.origin, ...optimizedStops.map((stop) => stop.coordinate)];
    const naiveWaypoints = [request.origin, ...request.stops];

    this.optimizedBoundsPoints = result.optimized_path ?? toLatLngs(optimizedWaypoints);
    this.naiveBoundsPoints = result.naive_path ?? toLatLngs(naiveWaypoints);

    L.polyline(this.optimizedBoundsPoints, {
      color: '#0057d9',
      weight: 6,
      opacity: 1,
      className: 'optimized-route-line',
    }).addTo(this.optimizedLayerGroup);

    L.polyline(this.naiveBoundsPoints, {
      color: '#4b5563',
      weight: 4,
      opacity: 0.9,
      dashArray: '8 9',
      className: 'naive-route-line',
    }).addTo(this.naiveLayerGroup);

    L.marker([request.origin.lat, request.origin.lng], {
      icon: L.divIcon({
        className: 'route-origin-icon',
        html: '<span aria-hidden="true"></span><b>Origin</b>',
        iconSize: [54, 46],
        iconAnchor: [27, 18],
      }),
      keyboard: false,
    }).addTo(this.optimizedLayerGroup);

    optimizedStops.forEach(({ inputIndex, coordinate }, optimizedIndex) => {
      L.marker([coordinate.lat, coordinate.lng], {
        icon: L.divIcon({
          className: 'route-stop-icon',
          html: `<span>${optimizedIndex + 1}</span><small>Stop ${inputIndex + 1}</small>`,
          iconSize: [58, 52],
          iconAnchor: [29, 16],
        }),
        keyboard: false,
        title: `Visit ${optimizedIndex + 1}: Stop ${inputIndex + 1}`,
      }).addTo(this.optimizedLayerGroup);
    });

    this.syncComparisonLayer(this.compareMode());
  }

  private renderDraftLocations(origin: CoordinateDraft | null, stops: StopDraft[]) {
    this.draftStopsLayerGroup.clearLayers();
    const boundsPoints: L.LatLngExpression[] = searchableAreaBoundsPoints(
      this.searchableAreaBounds,
    );
    const originCoordinate = origin ? parseDraftCoordinate(origin) : null;

    if (originCoordinate) {
      boundsPoints.push([originCoordinate.lat, originCoordinate.lng]);
      L.marker([originCoordinate.lat, originCoordinate.lng], {
        icon: L.divIcon({
          className: 'route-origin-icon route-draft-origin-icon',
          html: '<span aria-hidden="true"></span><b>Origin</b>',
          iconSize: [54, 46],
          iconAnchor: [27, 18],
        }),
        keyboard: false,
        title: origin?.resolvedAddress || 'Origin',
      }).addTo(this.draftStopsLayerGroup);
    }

    stops.forEach((stop, index) => {
      const coordinate = parseDraftCoordinate(stop);

      if (!coordinate) {
        return;
      }

      boundsPoints.push([coordinate.lat, coordinate.lng]);

      L.circle([coordinate.lat, coordinate.lng], {
        radius: this.snapRadiusM(),
        color: '#52525b',
        weight: 3,
        opacity: 1,
        dashArray: '10 7',
        fillColor: '#71717a',
        fillOpacity: 0.14,
        interactive: false,
        className: 'route-snap-radius',
      }).addTo(this.draftStopsLayerGroup);

      L.marker([coordinate.lat, coordinate.lng], {
        icon: L.divIcon({
          className: 'route-stop-icon route-draft-stop-icon',
          html: `<span aria-label="Stop ${index + 1}">${index + 1}</span>`,
          iconSize: [32, 32],
          iconAnchor: [16, 16],
        }),
        keyboard: false,
        title: stop.resolvedAddress || `Stop ${index + 1}`,
      }).addTo(this.draftStopsLayerGroup);
    });

    this.mapInstance?.fitBounds(L.latLngBounds(boundsPoints), {
      animate: false,
      padding: [36, 36],
      maxZoom: 15,
    });
  }

  private clearRouteLayers() {
    this.optimizedLayerGroup.clearLayers();
    this.naiveLayerGroup.clearLayers();
    this.optimizedBoundsPoints = [];
    this.naiveBoundsPoints = [];

    if (this.mapInstance?.hasLayer(this.naiveLayerGroup)) {
      this.mapInstance.removeLayer(this.naiveLayerGroup);
    }
  }

  private syncComparisonLayer(enabled: boolean) {
    if (!this.mapInstance) {
      return;
    }

    const shouldShowNaiveRoute = enabled && this.naiveBoundsPoints.length > 0;
    const isNaiveRouteVisible = this.mapInstance.hasLayer(this.naiveLayerGroup);

    if (shouldShowNaiveRoute && !isNaiveRouteVisible) {
      this.naiveLayerGroup.addTo(this.mapInstance);
    } else if (!shouldShowNaiveRoute && isNaiveRouteVisible) {
      this.mapInstance.removeLayer(this.naiveLayerGroup);
    }

    this.fitVisibleBounds(enabled);
  }

  private fitVisibleBounds(includeNaiveRoute: boolean) {
    if (!this.mapInstance || this.optimizedBoundsPoints.length === 0) {
      return;
    }

    const routePoints = includeNaiveRoute
      ? [...this.optimizedBoundsPoints, ...this.naiveBoundsPoints]
      : this.optimizedBoundsPoints;
    const points = [...searchableAreaBoundsPoints(this.searchableAreaBounds), ...routePoints];

    this.mapInstance.fitBounds(L.latLngBounds(points), {
      animate: false,
      padding: [32, 32],
      maxZoom: 15,
    });
  }
}

export function createVoyagerTileUrl(apiKey: string) {
  return apiKey ? `${VOYAGER_TILE_URL}?key=${encodeURIComponent(apiKey)}` : VOYAGER_TILE_URL;
}

function toLatLngs(coordinates: Coordinate[]): L.LatLngExpression[] {
  return coordinates.map(({ lat, lng }) => [lat, lng]);
}

function searchableAreaBoundsPoints(bounds: L.LatLngBounds): L.LatLngExpression[] {
  return [bounds.getSouthWest(), bounds.getNorthEast()];
}

function parseDraftCoordinate(draft: CoordinateDraft): Coordinate | null {
  if (
    (draft.inputMode === 'address' && draft.resolvedAddress === '') ||
    draft.lat.trim() === '' ||
    draft.lng.trim() === ''
  ) {
    return null;
  }

  const lat = Number(draft.lat);
  const lng = Number(draft.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return null;
  }

  return { lat, lng };
}
