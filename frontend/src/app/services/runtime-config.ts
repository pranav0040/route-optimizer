import { InjectionToken } from '@angular/core';

interface RouteOptimizerRuntimeConfig {
  apiBaseUrl?: string;
  cartoBasemapKey?: string;
}

declare global {
  interface Window {
    __ROUTE_OPTIMIZER_CONFIG__?: RouteOptimizerRuntimeConfig;
  }
}

export const CARTO_BASEMAP_KEY = new InjectionToken<string>('CARTO_BASEMAP_KEY', {
  providedIn: 'root',
  factory: () => {
    if (typeof window === 'undefined') {
      return '';
    }

    return window.__ROUTE_OPTIMIZER_CONFIG__?.cartoBasemapKey?.trim() ?? '';
  },
});
