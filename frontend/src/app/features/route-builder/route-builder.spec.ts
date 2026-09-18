import { fakeAsync, TestBed, tick } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';

import { ApiService } from '../../services/api.service';
import { RouteStateService } from '../../services/route-state.service';
import { RouteBuilderComponent } from './route-builder';

describe('RouteBuilderComponent', () => {
  let api: jasmine.SpyObj<ApiService>;

  beforeEach(async () => {
    api = jasmine.createSpyObj<ApiService>('ApiService', [
      'getRoutingCoverage',
      'geocodeAddress',
      'searchAddressSuggestions',
      'optimize',
      'pollJobUntilComplete',
    ]);
    api.getRoutingCoverage.and.returnValue(
      of({
        bounds: {
          south: 12.8467491,
          west: 77.5285614,
          north: 13.0391168,
          east: 77.7420454,
        },
        snap_radius_m: 500,
        routable_node_count: 148_000,
      }),
    );
    await TestBed.configureTestingModule({
      imports: [RouteBuilderComponent],
      providers: [
        provideRouter([]),
        {
          provide: ApiService,
          useValue: api,
        },
      ],
    }).compileComponents();
  });

  it('adds a stop from the route form', () => {
    const fixture = TestBed.createComponent(RouteBuilderComponent);

    fixture.detectChanges();
    expect(stopRows(fixture.nativeElement)).toBe(2);

    button(fixture.nativeElement, '[data-testid="add-stop"]').click();
    fixture.detectChanges();

    expect(stopRows(fixture.nativeElement)).toBe(3);
  });

  it('removes the selected stop from the route form', () => {
    const fixture = TestBed.createComponent(RouteBuilderComponent);

    fixture.detectChanges();
    const removeButtons = (
      fixture.nativeElement as HTMLElement
    ).querySelectorAll<HTMLButtonElement>('[data-testid="remove-stop"]');

    removeButtons[0].click();
    fixture.detectChanges();

    expect(stopRows(fixture.nativeElement)).toBe(1);
  });

  it('shows only the fields for the selected delivery-stop input mode', () => {
    const fixture = TestBed.createComponent(RouteBuilderComponent);

    fixture.detectChanges();
    expect(field(fixture.nativeElement, 'stop-lat-1')).not.toBeNull();
    expect(field(fixture.nativeElement, 'stop-lng-1')).not.toBeNull();
    expect(field(fixture.nativeElement, 'stop-address-1')).toBeNull();

    button(fixture.nativeElement, '[data-testid="stop-address-mode-1"]').click();
    fixture.detectChanges();

    expect(field(fixture.nativeElement, 'stop-address-1')).not.toBeNull();
    expect(field(fixture.nativeElement, 'stop-lat-1')).toBeNull();
    expect(field(fixture.nativeElement, 'stop-lng-1')).toBeNull();

    button(fixture.nativeElement, '[data-testid="stop-coordinate-mode-1"]').click();
    fixture.detectChanges();

    expect(field(fixture.nativeElement, 'stop-address-1')).toBeNull();
    expect(field(fixture.nativeElement, 'stop-lat-1')).not.toBeNull();
    expect(field(fixture.nativeElement, 'stop-lng-1')).not.toBeNull();
  });

  it('shows starting-address suggestions and maps the selected result', () => {
    const routeState = TestBed.inject(RouteStateService);

    routeState.setOriginInputMode('address');
    routeState.updateOriginAddress('Cubbon Park');
    api.searchAddressSuggestions.and.returnValue(
      of({
        suggestions: [
          {
            lat: 12.976347,
            lng: 77.592928,
            display_name: 'Cubbon Park, Bengaluru, Karnataka, India',
            cached: false,
          },
        ],
      }),
    );
    const fixture = TestBed.createComponent(RouteBuilderComponent);

    fixture.detectChanges();
    button(fixture.nativeElement, '[data-testid="search-origin-address"]').click();
    fixture.detectChanges();

    expect(api.searchAddressSuggestions).toHaveBeenCalledOnceWith('Cubbon Park');
    expect(
      fixture.nativeElement.querySelectorAll('[data-testid="origin-suggestions"] li').length,
    ).toBe(1);

    button(fixture.nativeElement, '[data-testid="origin-suggestions"] li button').click();
    fixture.detectChanges();

    expect(routeState.origin()).toEqual(
      jasmine.objectContaining({
        address: 'Cubbon Park, Bengaluru, Karnataka, India',
        lat: '12.976347',
        lng: '77.592928',
        resolvedAddress: 'Cubbon Park, Bengaluru, Karnataka, India',
      }),
    );
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('.route-draft-origin-icon'),
    ).not.toBeNull();
  });

  it('automatically searches for starting-address suggestions while typing', fakeAsync(() => {
    api.searchAddressSuggestions.and.returnValue(
      of({
        suggestions: [
          {
            lat: 12.9742535,
            lng: 77.5921906,
            display_name: 'Cubbon Park, Bengaluru, Karnataka, India',
            cached: false,
          },
        ],
      }),
    );
    const fixture = TestBed.createComponent(RouteBuilderComponent);
    const component = fixture.componentInstance as unknown as {
      setOriginInputMode(inputMode: 'address'): void;
      updateOriginAddress(value: string): void;
    };

    fixture.detectChanges();
    component.setOriginInputMode('address');
    component.updateOriginAddress('cubb');
    fixture.detectChanges();
    tick(449);
    expect(api.searchAddressSuggestions).not.toHaveBeenCalled();
    tick(1);
    fixture.detectChanges();

    expect(api.searchAddressSuggestions).toHaveBeenCalledOnceWith('cubb');
    expect(
      fixture.nativeElement.querySelectorAll('[data-testid="origin-suggestions"] li').length,
    ).toBe(1);
  }));

  it('keeps coordinate entry as the default optimization flow', () => {
    api.optimize.and.returnValue(
      of({
        optimized_order: [0, 1],
        total_distance_m: 1_000,
        total_duration_s: 100,
        naive_distance_m: 1_000,
        improvement_pct: 0,
        cached: false,
      }),
    );
    const fixture = TestBed.createComponent(RouteBuilderComponent);

    fixture.detectChanges();
    submit(fixture.nativeElement);

    expect(api.geocodeAddress).not.toHaveBeenCalled();
    expect(api.optimize).toHaveBeenCalledWith({
      origin: { lat: 12.9716, lng: 77.5946 },
      stops: [
        { lat: 12.9611, lng: 77.6387 },
        { lat: 12.9352, lng: 77.6146 },
      ],
    });
  });

  it('shows visit positions that match map markers and identifies the source stops', () => {
    const routeState = TestBed.inject(RouteStateService);
    routeState.currentRouteResult.set({
      optimized_order: [1, 0],
      total_distance_m: 1_000,
      total_duration_s: 100,
      naive_distance_m: 1_200,
      improvement_pct: 16.7,
      cached: false,
    });
    const fixture = TestBed.createComponent(RouteBuilderComponent);

    fixture.detectChanges();

    const rows = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll(
        '[data-testid="recommended-stop-order"] li',
      ),
      (row) => ({
        marker: row.querySelector('b')?.textContent?.trim(),
        stop: row.querySelector('strong')?.textContent?.trim(),
        location: row.querySelector('small')?.textContent?.trim(),
      }),
    );
    expect(rows).toEqual([
      { marker: '1', stop: 'Stop 2', location: '12.9352, 77.6146' },
      { marker: '2', stop: 'Stop 1', location: '12.9611, 77.6387' },
    ]);
  });

  it('geocodes an address stop before optimizing and stores the matched coordinates', () => {
    const routeState = TestBed.inject(RouteStateService);

    routeState.setStopInputMode(1, 'address');
    routeState.updateStopAddress(1, 'Cubbon Park, Bengaluru');
    api.geocodeAddress.and.returnValue(
      of({
        lat: 12.976347,
        lng: 77.592928,
        display_name: 'Cubbon Park, Bengaluru, Karnataka, India',
        cached: false,
      }),
    );
    api.optimize.and.returnValue(
      of({
        optimized_order: [0, 1],
        total_distance_m: 1_000,
        total_duration_s: 100,
        naive_distance_m: 1_000,
        improvement_pct: 0,
        cached: false,
      }),
    );
    const fixture = TestBed.createComponent(RouteBuilderComponent);

    fixture.detectChanges();
    submit(fixture.nativeElement);

    expect(api.geocodeAddress).toHaveBeenCalledOnceWith('Cubbon Park, Bengaluru');
    expect(api.optimize).toHaveBeenCalledWith({
      origin: { lat: 12.9716, lng: 77.5946 },
      stops: [
        { lat: 12.976347, lng: 77.592928 },
        { lat: 12.9352, lng: 77.6146 },
      ],
    });
    expect(routeState.stops()[0]).toEqual(
      jasmine.objectContaining({
        lat: '12.976347',
        lng: '77.592928',
        resolvedAddress: 'Cubbon Park, Bengaluru, Karnataka, India',
      }),
    );
  });
});

function stopRows(element: HTMLElement) {
  return element.querySelectorAll('[data-testid="stop-row"]').length;
}

function button(element: HTMLElement, selector: string) {
  const result = element.querySelector<HTMLButtonElement>(selector);

  if (!result) {
    throw new Error(`Could not find ${selector}`);
  }

  return result;
}

function field(element: HTMLElement, testId: string) {
  return element.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
}

function submit(element: HTMLElement) {
  const form = element.querySelector<HTMLFormElement>('form');

  if (!form) {
    throw new Error('Could not find route form');
  }

  form.dispatchEvent(new Event('submit'));
}
