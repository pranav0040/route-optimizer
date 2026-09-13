import { TestBed } from '@angular/core/testing';
import * as L from 'leaflet';

import type { OptimizeRequest, OptimizedRouteResponse } from '../../models/api.models';
import { RouteStateService } from '../../services/route-state.service';
import {
  createVoyagerTileUrl,
  RouteMapComponent,
  SNAP_RADIUS_M,
  VOYAGER_TILE_URL,
} from './route-map';

interface RouteMapInternals {
  mapInstance: L.Map;
  draftStopsLayerGroup: L.LayerGroup;
  naiveLayerGroup: L.LayerGroup;
}

describe('RouteMapComponent', () => {
  let routeState: RouteStateService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RouteMapComponent],
    }).compileComponents();

    routeState = TestBed.inject(RouteStateService);
  });

  it('adds the configured CARTO key to the Voyager tile URL', () => {
    expect(createVoyagerTileUrl('portfolio key')).toBe(`${VOYAGER_TILE_URL}?key=portfolio%20key`);
    expect(createVoyagerTileUrl('')).toBe(VOYAGER_TILE_URL);
  });

  it('adds a numbered draft marker immediately after a map click', () => {
    const fixture = TestBed.createComponent(RouteMapComponent);
    fixture.detectChanges();
    const internals = fixture.componentInstance as unknown as RouteMapInternals;

    internals.mapInstance.fire('click', { latlng: L.latLng(12.9484, 77.6102) });
    fixture.detectChanges();

    const markers = (fixture.nativeElement as HTMLElement).querySelectorAll(
      '.route-draft-stop-icon',
    );
    expect(routeState.stops().at(-1)).toEqual({
      id: 3,
      lat: '12.948400',
      lng: '77.610200',
    });
    expect(markers.length).toBe(3);
    expect(Array.from(markers, (marker) => marker.querySelector('span')?.textContent)).toEqual([
      '1',
      '2',
      '3',
    ]);

    const radiusOutlines = internals.draftStopsLayerGroup
      .getLayers()
      .filter((layer): layer is L.Circle => layer instanceof L.Circle);
    expect(radiusOutlines.length).toBe(3);
    expect(radiusOutlines.every((circle) => circle.getRadius() === SNAP_RADIUS_M)).toBeTrue();
    expect(
      (fixture.nativeElement as HTMLElement)
        .querySelector('[data-testid="snap-radius-legend"]')
        ?.textContent?.trim(),
    ).toContain('250 m snap radius');
  });

  it('renumbers draft markers when a stop is removed', () => {
    const fixture = TestBed.createComponent(RouteMapComponent);
    fixture.detectChanges();

    routeState.removeStop(1);
    fixture.detectChanges();

    const markers = (fixture.nativeElement as HTMLElement).querySelectorAll(
      '.route-draft-stop-icon',
    );
    expect(markers.length).toBe(1);
    expect(markers[0].querySelector('span')?.textContent).toBe('1');
  });

  it('renders one numbered marker for every stop', () => {
    seedRoute(routeState, [2, 0, 1]);
    const fixture = TestBed.createComponent(RouteMapComponent);

    fixture.detectChanges();

    const markers = (fixture.nativeElement as HTMLElement).querySelectorAll('.route-stop-icon');
    expect(markers.length).toBe(3);
    expect(Array.from(markers, (marker) => marker.querySelector('span')?.textContent)).toEqual([
      '1',
      '2',
      '3',
    ]);
  });

  it('shows previous-position labels only for reordered stops', () => {
    seedRoute(routeState, [1, 0, 2]);
    const fixture = TestBed.createComponent(RouteMapComponent);

    fixture.detectChanges();

    const labels = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('.route-stop-icon small'),
      (label) => label.textContent?.trim(),
    );
    expect(labels).toEqual(['was 2nd', 'was 1st']);
  });

  it('adds and removes the same naive layer group when comparison is toggled', () => {
    seedRoute(routeState, [1, 0, 2]);
    const fixture = TestBed.createComponent(RouteMapComponent);
    fixture.detectChanges();
    const internals = fixture.componentInstance as unknown as RouteMapInternals;
    const naiveLayerGroup = internals.naiveLayerGroup;

    expect(internals.mapInstance.hasLayer(naiveLayerGroup)).toBeFalse();

    click(fixture.nativeElement, '[data-testid="compare-both"]');
    fixture.detectChanges();
    expect(internals.mapInstance.hasLayer(naiveLayerGroup)).toBeTrue();

    click(fixture.nativeElement, '[data-testid="optimized-only"]');
    fixture.detectChanges();
    expect(internals.mapInstance.hasLayer(naiveLayerGroup)).toBeFalse();

    click(fixture.nativeElement, '[data-testid="compare-both"]');
    fixture.detectChanges();
    expect(internals.naiveLayerGroup).toBe(naiveLayerGroup);
    expect(internals.mapInstance.hasLayer(naiveLayerGroup)).toBeTrue();
  });
});

function seedRoute(routeState: RouteStateService, optimizedOrder: number[]) {
  const request: OptimizeRequest = {
    origin: { lat: 12.9716, lng: 77.5946 },
    stops: [
      { lat: 12.9611, lng: 77.6387 },
      { lat: 12.9352, lng: 77.6146 },
      { lat: 12.9279, lng: 77.6271 },
    ],
  };
  const result: OptimizedRouteResponse = {
    optimized_order: optimizedOrder,
    total_distance_m: 12_000,
    total_duration_s: 1_200,
    naive_distance_m: 15_000,
    naive_duration_s: 1_500,
    improvement_pct: 20,
    cached: false,
  };

  routeState.submittedRequest.set(request);
  routeState.currentRouteResult.set(result);
}

function click(element: HTMLElement, selector: string) {
  const target = element.querySelector<HTMLButtonElement>(selector);

  if (!target) {
    throw new Error(`Could not find ${selector}`);
  }

  target.click();
}
