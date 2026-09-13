import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
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
import * as L from 'leaflet';

import type { Coordinate, OptimizeRequest, OptimizedRouteResponse } from '../../models/api.models';
import { RouteStateService, type StopDraft } from '../../services/route-state.service';
import { CARTO_BASEMAP_KEY } from '../../services/runtime-config';

export const VOYAGER_TILE_URL =
  'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
export const BASEMAP_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, ' +
  '&copy; <a href="https://carto.com/attributions">CARTO</a>';

const DEFAULT_CENTER: L.LatLngExpression = [12.9716, 77.5946];
export const SNAP_RADIUS_M = 250;

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
  private readonly cartoBasemapKey = inject(CARTO_BASEMAP_KEY);
  private mapInstance?: L.Map;
  private readonly draftStopsLayerGroup = L.layerGroup();
  private readonly optimizedLayerGroup = L.layerGroup();
  private readonly naiveLayerGroup = L.layerGroup();
  private optimizedBoundsPoints: L.LatLngExpression[] = [];
  private naiveBoundsPoints: L.LatLngExpression[] = [];

  protected readonly compareMode = signal(false);
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
    const stops = this.routeState.stops();
    const hasOptimizedRoute = this.routeResult() !== null;

    if (this.mapInstance) {
      untracked(() => this.renderDraftStops(hasOptimizedRoute ? [] : stops));
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
    this.draftStopsLayerGroup.addTo(this.mapInstance);
    this.optimizedLayerGroup.addTo(this.mapInstance);
    this.mapInstance.on('click', ({ latlng }: L.LeafletMouseEvent) => {
      this.routeState.addCoordinateStop({ lat: latlng.lat, lng: latlng.lng });
    });

    const request = this.routeState.submittedRequest();
    const result = this.routeResult();

    if (request && result) {
      this.renderRoute(request, result);
    } else {
      this.renderDraftStops(this.routeState.stops());
    }
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
      const changedPosition = inputIndex !== optimizedIndex;
      const previousPosition = changedPosition
        ? `<small>was ${ordinal(inputIndex + 1)}</small>`
        : '';

      L.marker([coordinate.lat, coordinate.lng], {
        icon: L.divIcon({
          className: 'route-stop-icon',
          html: `<span>${optimizedIndex + 1}</span>${previousPosition}`,
          iconSize: [58, changedPosition ? 52 : 32],
          iconAnchor: [29, 16],
        }),
        keyboard: false,
      }).addTo(this.optimizedLayerGroup);
    });

    this.syncComparisonLayer(this.compareMode());
  }

  private renderDraftStops(stops: StopDraft[]) {
    this.draftStopsLayerGroup.clearLayers();

    stops.forEach((stop, index) => {
      const coordinate = parseDraftCoordinate(stop);

      if (!coordinate) {
        return;
      }

      L.circle([coordinate.lat, coordinate.lng], {
        radius: SNAP_RADIUS_M,
        color: '#7c3aed',
        weight: 3,
        opacity: 1,
        dashArray: '10 7',
        fillColor: '#a855f7',
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
        title: `Stop ${index + 1}`,
      }).addTo(this.draftStopsLayerGroup);
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

    const points = includeNaiveRoute
      ? [...this.optimizedBoundsPoints, ...this.naiveBoundsPoints]
      : this.optimizedBoundsPoints;

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

function parseDraftCoordinate(stop: StopDraft): Coordinate | null {
  if (stop.lat.trim() === '' || stop.lng.trim() === '') {
    return null;
  }

  const lat = Number(stop.lat);
  const lng = Number(stop.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return null;
  }

  return { lat, lng };
}

function ordinal(value: number) {
  const remainder100 = value % 100;

  if (remainder100 >= 11 && remainder100 <= 13) {
    return `${value}th`;
  }

  return `${value}${['th', 'st', 'nd', 'rd'][Math.min(value % 10, 4)]}`;
}
