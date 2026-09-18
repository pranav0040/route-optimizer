import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod';

import type { RouteResponseCache } from '../cache/route-cache.js';

const DEFAULT_GEOCODER_URL = 'https://nominatim.openstreetmap.org/search';
const DEFAULT_REVERSE_GEOCODER_URL = 'https://nominatim.openstreetmap.org/reverse';
const DEFAULT_SUGGESTIONS_URL = 'https://photon.komoot.io/api';
const DEFAULT_GEOCODER_USER_AGENT = 'RouteOptimizer/0.1 (local route-planning application)';
const DEFAULT_GEOCODER_COUNTRY_CODES = 'in';
const DEFAULT_GEOCODER_VIEWBOX = '77.5285614,13.0391168,77.7420454,12.8467491';
const DEFAULT_SUGGESTIONS_BBOX = '77.5285614,12.8467491,77.7420454,13.0391168';
const DEFAULT_REQUEST_INTERVAL_MS = 1_000;

const nominatimResponseSchema = z.array(
  z.object({
    lat: z.string(),
    lon: z.string(),
    display_name: z.string()
  })
);

const nominatimReverseResponseSchema = z.union([
  z.object({
    lat: z.string(),
    lon: z.string(),
    display_name: z.string()
  }),
  z.object({ error: z.string() })
]);

const photonResponseSchema = z.object({
  features: z.array(
    z.object({
      geometry: z.object({ coordinates: z.tuple([z.number(), z.number()]) }),
      properties: z.object({
        name: z.string().optional(),
        housenumber: z.string().optional(),
        street: z.string().optional(),
        district: z.string().optional(),
        city: z.string().optional(),
        county: z.string().optional(),
        state: z.string().optional(),
        postcode: z.string().optional(),
        country: z.string().optional()
      })
    })
  )
});

export interface GeocodeResult {
  lat: number;
  lng: number;
  displayName: string;
  cached: boolean;
}

export interface Geocoder {
  geocode(address: string): Promise<GeocodeResult | null>;
  reverse(lat: number, lng: number): Promise<GeocodeResult | null>;
  search(address: string, limit: number): Promise<GeocodeResult[]>;
}

export interface NominatimGeocoderOptions {
  cache?: RouteResponseCache;
  baseUrl?: string;
  reverseUrl?: string;
  suggestionsUrl?: string;
  userAgent?: string;
  countryCodes?: string;
  viewbox?: string;
  suggestionsBbox?: string;
  requestIntervalMs?: number;
  fetch?: typeof fetch;
}

interface CachedGeocodeResult {
  lat: number;
  lng: number;
  displayName: string;
}

interface GeocodeCacheEntry {
  results: CachedGeocodeResult[];
}

export class GeocoderUnavailableError extends Error {}

export class NominatimGeocoder implements Geocoder {
  private readonly cache?: RouteResponseCache;
  private readonly baseUrl: string;
  private readonly reverseUrl: string;
  private readonly suggestionsUrl: string;
  private readonly userAgent: string;
  private readonly countryCodes: string;
  private readonly viewbox: string;
  private readonly suggestionsBbox: string;
  private readonly requestIntervalMs: number;
  private readonly fetchImplementation: typeof fetch;
  private readonly inFlight = new Map<string, Promise<GeocodeResult[]>>();
  private readonly reverseInFlight = new Map<string, Promise<GeocodeResult | null>>();
  private requestQueue: Promise<void> = Promise.resolve();
  private lastRequestStartedAt = 0;

  constructor(options: NominatimGeocoderOptions = {}) {
    this.cache = options.cache;
    this.baseUrl = options.baseUrl ?? process.env.GEOCODER_URL ?? DEFAULT_GEOCODER_URL;
    this.reverseUrl =
      options.reverseUrl ?? process.env.GEOCODER_REVERSE_URL ?? DEFAULT_REVERSE_GEOCODER_URL;
    this.suggestionsUrl =
      options.suggestionsUrl ?? process.env.GEOCODER_SUGGESTIONS_URL ?? DEFAULT_SUGGESTIONS_URL;
    this.userAgent =
      options.userAgent ?? process.env.GEOCODER_USER_AGENT ?? DEFAULT_GEOCODER_USER_AGENT;
    this.countryCodes =
      options.countryCodes ?? process.env.GEOCODER_COUNTRY_CODES ?? DEFAULT_GEOCODER_COUNTRY_CODES;
    this.viewbox = options.viewbox ?? process.env.GEOCODER_VIEWBOX ?? DEFAULT_GEOCODER_VIEWBOX;
    this.suggestionsBbox =
      options.suggestionsBbox ?? process.env.GEOCODER_SUGGESTIONS_BBOX ?? DEFAULT_SUGGESTIONS_BBOX;
    this.requestIntervalMs = options.requestIntervalMs ?? DEFAULT_REQUEST_INTERVAL_MS;
    this.fetchImplementation = options.fetch ?? fetch;

    if (!Number.isFinite(this.requestIntervalMs) || this.requestIntervalMs < 0) {
      throw new RangeError('Geocoder request interval must be a non-negative number.');
    }
  }

  async geocode(address: string): Promise<GeocodeResult | null> {
    return (await this.search(address, 1))[0] ?? null;
  }

  async reverse(lat: number, lng: number): Promise<GeocodeResult | null> {
    const cacheKey = createReverseGeocodeCacheKey(lat, lng);
    const cachedEntry = await this.cache?.get<GeocodeCacheEntry>(cacheKey);

    if (cachedEntry) {
      const result = cachedEntry.results[0];
      return result ? { ...result, cached: true } : null;
    }

    const existingRequest = this.reverseInFlight.get(cacheKey);

    if (existingRequest) {
      return existingRequest;
    }

    const request = this.enqueue(async () => {
      const result = await this.fetchNominatimReverseResult(lat, lng);
      await this.cache?.set(cacheKey, {
        results: result ? [result] : []
      } satisfies GeocodeCacheEntry);

      return result ? { ...result, cached: false } : null;
    });

    this.reverseInFlight.set(cacheKey, request);

    try {
      return await request;
    } finally {
      this.reverseInFlight.delete(cacheKey);
    }
  }

  async search(address: string, limit: number): Promise<GeocodeResult[]> {
    const normalizedAddress = normalizeAddress(address);
    const normalizedLimit = Math.max(1, Math.min(10, Math.floor(limit)));
    const provider = normalizedLimit === 1 ? 'nominatim' : 'photon';
    const cacheKey = createGeocodeCacheKey(normalizedAddress, normalizedLimit, provider);
    const cachedEntry = await this.cache?.get<GeocodeCacheEntry>(cacheKey);

    if (cachedEntry) {
      return cachedEntry.results.map((result) => ({ ...result, cached: true }));
    }

    const existingRequest = this.inFlight.get(cacheKey);

    if (existingRequest) {
      return existingRequest;
    }

    const request = this.enqueue(async () => {
      const results =
        provider === 'photon'
          ? await this.fetchPhotonResults(normalizedAddress, normalizedLimit)
          : await this.fetchNominatimResults(normalizedAddress, normalizedLimit);

      await this.cache?.set(cacheKey, { results } satisfies GeocodeCacheEntry);

      return results.map((result) => ({ ...result, cached: false }));
    });

    this.inFlight.set(cacheKey, request);

    try {
      return await request;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.requestQueue.then(async () => {
      const waitMs = Math.max(0, this.lastRequestStartedAt + this.requestIntervalMs - Date.now());

      if (waitMs > 0) {
        await delay(waitMs);
      }

      this.lastRequestStartedAt = Date.now();
      return operation();
    });

    this.requestQueue = queued.then(
      () => undefined,
      () => undefined
    );

    return queued;
  }

  private async fetchNominatimResults(
    address: string,
    limit: number
  ): Promise<CachedGeocodeResult[]> {
    const url = new URL(this.baseUrl);

    url.searchParams.set('q', address);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('addressdetails', '0');

    if (this.countryCodes) {
      url.searchParams.set('countrycodes', this.countryCodes);
    }

    if (this.viewbox) {
      url.searchParams.set('viewbox', this.viewbox);
      url.searchParams.set('bounded', '1');
    }

    let response: Response;

    try {
      response = await this.fetchImplementation(url, {
        headers: {
          Accept: 'application/json',
          'Accept-Language': 'en',
          'User-Agent': this.userAgent
        },
        signal: AbortSignal.timeout(10_000)
      });
    } catch (error) {
      throw new GeocoderUnavailableError(
        `The address search service could not be reached: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }

    if (!response.ok) {
      throw new GeocoderUnavailableError(
        `The address search service returned HTTP ${response.status}.`
      );
    }

    const parsed = nominatimResponseSchema.safeParse(await response.json());

    if (!parsed.success) {
      throw new GeocoderUnavailableError(
        'The address search service returned an invalid response.'
      );
    }

    return parsed.data.map((match) => {
      const lat = Number(match.lat);
      const lng = Number(match.lon);

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        throw new GeocoderUnavailableError(
          'The address search service returned invalid coordinates.'
        );
      }

      return { lat, lng, displayName: match.display_name };
    });
  }

  private async fetchPhotonResults(address: string, limit: number): Promise<CachedGeocodeResult[]> {
    const url = new URL(this.suggestionsUrl);

    url.searchParams.set('q', address);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('lang', 'en');
    url.searchParams.set('countrycode', 'IN');
    url.searchParams.set('lat', '12.965');
    url.searchParams.set('lon', '77.63');

    if (this.suggestionsBbox) {
      url.searchParams.set('bbox', this.suggestionsBbox);
    }

    let response: Response;

    try {
      response = await this.fetchImplementation(url, {
        headers: { Accept: 'application/json', 'User-Agent': this.userAgent },
        signal: AbortSignal.timeout(10_000)
      });
    } catch (error) {
      throw new GeocoderUnavailableError(
        `The address suggestion service could not be reached: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }

    if (!response.ok) {
      throw new GeocoderUnavailableError(
        `The address suggestion service returned HTTP ${response.status}.`
      );
    }

    const parsed = photonResponseSchema.safeParse(await response.json());

    if (!parsed.success) {
      throw new GeocoderUnavailableError(
        'The address suggestion service returned an invalid response.'
      );
    }

    return parsed.data.features.map(({ geometry, properties }) => ({
      lat: geometry.coordinates[1],
      lng: geometry.coordinates[0],
      displayName: displayPhotonAddress(properties)
    }));
  }

  private async fetchNominatimReverseResult(
    lat: number,
    lng: number
  ): Promise<CachedGeocodeResult | null> {
    const url = new URL(this.reverseUrl);

    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lng));
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('zoom', '18');
    url.searchParams.set('addressdetails', '0');

    let response: Response;

    try {
      response = await this.fetchImplementation(url, {
        headers: {
          Accept: 'application/json',
          'Accept-Language': 'en',
          'User-Agent': this.userAgent
        },
        signal: AbortSignal.timeout(10_000)
      });
    } catch (error) {
      throw new GeocoderUnavailableError(
        `The reverse geocoding service could not be reached: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }

    if (!response.ok) {
      throw new GeocoderUnavailableError(
        `The reverse geocoding service returned HTTP ${response.status}.`
      );
    }

    const parsed = nominatimReverseResponseSchema.safeParse(await response.json());

    if (!parsed.success) {
      throw new GeocoderUnavailableError(
        'The reverse geocoding service returned an invalid response.'
      );
    }

    if ('error' in parsed.data) {
      return null;
    }

    const resultLat = Number(parsed.data.lat);
    const resultLng = Number(parsed.data.lon);

    if (!Number.isFinite(resultLat) || !Number.isFinite(resultLng)) {
      throw new GeocoderUnavailableError(
        'The reverse geocoding service returned invalid coordinates.'
      );
    }

    return { lat: resultLat, lng: resultLng, displayName: parsed.data.display_name };
  }
}

function normalizeAddress(address: string) {
  return address.trim().replace(/\s+/g, ' ');
}

function createGeocodeCacheKey(normalizedAddress: string, limit: number, provider: string) {
  const digest = createHash('sha256')
    .update(`${provider}|${normalizedAddress.toLocaleLowerCase('en')}|${limit}`)
    .digest('hex');

  return `geocode-cache:v2:${digest}`;
}

function createReverseGeocodeCacheKey(lat: number, lng: number) {
  const digest = createHash('sha256')
    .update(`${lat.toFixed(6)}|${lng.toFixed(6)}`)
    .digest('hex');

  return `reverse-geocode-cache:v1:${digest}`;
}

function displayPhotonAddress(
  properties: z.infer<typeof photonResponseSchema>['features'][number]['properties']
) {
  const parts = [
    properties.name,
    properties.housenumber,
    properties.street,
    properties.district,
    properties.city,
    properties.county,
    properties.state,
    properties.postcode,
    properties.country
  ].filter((part): part is string => Boolean(part));

  return [...new Set(parts)].join(', ');
}
