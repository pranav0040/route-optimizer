import { describe, expect, it, vi } from 'vitest';

import type { RouteResponseCache } from '../src/cache/route-cache.js';
import { NominatimGeocoder } from '../src/geocoding/geocoder.js';

describe('NominatimGeocoder', () => {
  it('searches inside the configured area and caches a successful result', async () => {
    const cache = new MemoryCache();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            {
              lat: '12.976347',
              lon: '77.592928',
              display_name: 'Cubbon Park, Bengaluru, Karnataka, India'
            }
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );
    const geocoder = new NominatimGeocoder({
      cache,
      fetch: fetchMock,
      requestIntervalMs: 0,
      baseUrl: 'https://geocoder.example/search',
      userAgent: 'RouteOptimizerTest/1.0',
      countryCodes: 'in',
      viewbox: '77.54,13.03,77.72,12.90'
    });

    const first = await geocoder.geocode('  Cubbon   Park  ');
    const second = await geocoder.geocode('Cubbon Park');

    expect(first).toEqual({
      lat: 12.976347,
      lng: 77.592928,
      displayName: 'Cubbon Park, Bengaluru, Karnataka, India',
      cached: false
    });
    expect(second).toEqual({ ...first, cached: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [requestedUrl, options] = fetchMock.mock.calls[0];
    const url = new URL(requestedUrl);

    expect(url.searchParams.get('q')).toBe('Cubbon Park');
    expect(url.searchParams.get('countrycodes')).toBe('in');
    expect(url.searchParams.get('viewbox')).toBe('77.54,13.03,77.72,12.90');
    expect(url.searchParams.get('bounded')).toBe('1');
    expect(options?.headers).toMatchObject({ 'User-Agent': 'RouteOptimizerTest/1.0' });
  });

  it('returns null when no address matches', async () => {
    const fetchMock = vi.fn(async () => new Response('[]', { status: 200 }));
    const geocoder = new NominatimGeocoder({
      cache: new MemoryCache(),
      fetch: fetchMock,
      requestIntervalMs: 0
    });

    await expect(geocoder.geocode('Unknown place')).resolves.toBeNull();
    await expect(geocoder.geocode('Unknown place')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses Photon to return prefix suggestions inside the configured map area', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            features: [
              {
                geometry: { type: 'Point', coordinates: [77.5921906, 12.9742535] },
                properties: {
                  name: 'Cubbon Park',
                  district: 'Sampangirama Nagar',
                  city: 'Bengaluru',
                  state: 'Karnataka',
                  country: 'India'
                }
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );
    const geocoder = new NominatimGeocoder({
      fetch: fetchMock,
      requestIntervalMs: 0,
      suggestionsUrl: 'https://suggestions.example/api',
      suggestionsBbox: '77.54,12.90,77.72,13.03'
    });

    await expect(geocoder.search('cubb', 5)).resolves.toEqual([
      {
        lat: 12.9742535,
        lng: 77.5921906,
        displayName: 'Cubbon Park, Sampangirama Nagar, Bengaluru, Karnataka, India',
        cached: false
      }
    ]);
    const [requestedUrl] = fetchMock.mock.calls[0];
    const url = new URL(requestedUrl);

    expect(url.searchParams.get('q')).toBe('cubb');
    expect(url.searchParams.get('bbox')).toBe('77.54,12.90,77.72,13.03');
    expect(url.searchParams.get('countrycode')).toBe('IN');
  });

  it('reverse geocodes a selected map coordinate and caches the address', async () => {
    const cache = new MemoryCache();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            lat: '12.976347',
            lon: '77.592928',
            display_name: 'Cubbon Park, Bengaluru, Karnataka, India'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );
    const geocoder = new NominatimGeocoder({
      cache,
      fetch: fetchMock,
      requestIntervalMs: 0,
      reverseUrl: 'https://geocoder.example/reverse'
    });

    const first = await geocoder.reverse(12.976347, 77.592928);
    const second = await geocoder.reverse(12.976347, 77.592928);

    expect(first).toEqual({
      lat: 12.976347,
      lng: 77.592928,
      displayName: 'Cubbon Park, Bengaluru, Karnataka, India',
      cached: false
    });
    expect(second).toEqual({ ...first, cached: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [requestedUrl] = fetchMock.mock.calls[0];
    const url = new URL(requestedUrl);
    expect(url.searchParams.get('lat')).toBe('12.976347');
    expect(url.searchParams.get('lon')).toBe('77.592928');
    expect(url.searchParams.get('zoom')).toBe('18');
  });
});

class MemoryCache implements RouteResponseCache {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | null> {
    return (this.values.get(key) as T | undefined) ?? null;
  }

  async set<T>(key: string, value: T) {
    this.values.set(key, value);
  }
}
