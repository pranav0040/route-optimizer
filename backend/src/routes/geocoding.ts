import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import {
  GeocoderUnavailableError,
  type Geocoder,
  type GeocodeResult
} from '../geocoding/geocoder.js';
import { ApiError } from '../http/api-error.js';

const searchSchema = z.object({
  address: z.string().trim().min(3).max(300)
});
const reverseSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180)
});

export function createGeocodingRouter(geocoder: Geocoder) {
  const router = Router();

  router.get(
    '/search',
    asyncHandler(async (req, res) => {
      const { address } = searchSchema.parse(req.query);
      let result;

      try {
        result = await geocoder.geocode(address);
      } catch (error) {
        if (error instanceof GeocoderUnavailableError) {
          throw new ApiError(
            502,
            'GEOCODER_UNAVAILABLE',
            'Address search is temporarily unavailable.'
          );
        }

        throw error;
      }

      if (!result) {
        throw new ApiError(
          422,
          'ADDRESS_NOT_FOUND',
          `No address match was found for "${address}" in the supported map area.`
        );
      }

      res.json({
        lat: result.lat,
        lng: result.lng,
        display_name: result.displayName,
        cached: result.cached
      });
    })
  );

  router.get(
    '/suggestions',
    asyncHandler(async (req, res) => {
      const { address } = searchSchema.parse(req.query);
      const suggestions = await searchOrThrow(geocoder, address, 5);

      res.json({
        suggestions: suggestions.map(toResponse)
      });
    })
  );

  router.get(
    '/reverse',
    asyncHandler(async (req, res) => {
      const { lat, lng } = reverseSchema.parse(req.query);
      const result = await reverseOrThrow(geocoder, lat, lng);

      if (!result) {
        throw new ApiError(
          422,
          'ADDRESS_NOT_FOUND',
          'No address was found for the selected map point.'
        );
      }

      res.json(toResponse(result));
    })
  );

  return router;
}

async function searchOrThrow(geocoder: Geocoder, address: string, limit: number) {
  try {
    return await geocoder.search(address, limit);
  } catch (error) {
    if (error instanceof GeocoderUnavailableError) {
      throw new ApiError(502, 'GEOCODER_UNAVAILABLE', 'Address search is temporarily unavailable.');
    }

    throw error;
  }
}

async function reverseOrThrow(geocoder: Geocoder, lat: number, lng: number) {
  try {
    return await geocoder.reverse(lat, lng);
  } catch (error) {
    if (error instanceof GeocoderUnavailableError) {
      throw new ApiError(502, 'GEOCODER_UNAVAILABLE', 'Address lookup is temporarily unavailable.');
    }

    throw error;
  }
}

function toResponse(result: GeocodeResult) {
  return {
    lat: result.lat,
    lng: result.lng,
    display_name: result.displayName,
    cached: result.cached
  };
}

function asyncHandler(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res, next).catch(next);
  };
}
