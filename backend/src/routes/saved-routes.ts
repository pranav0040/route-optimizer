import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import type { RouteRepository } from '../db/route-repository.js';
import { ApiError } from '../http/api-error.js';

const routeIdSchema = z.string().uuid();

export function createSavedRouteRouter(repository: RouteRepository) {
  const router = Router();

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const parsedId = routeIdSchema.safeParse(req.params.id);

      if (!parsedId.success) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'Route ID must be a valid UUID.');
      }

      const route = await repository.getRoute(parsedId.data);

      if (!route) {
        throw new ApiError(404, 'ROUTE_NOT_FOUND', 'No optimized route exists for this route ID.');
      }

      res.json({
        route_id: route.id,
        origin: route.origin,
        stops: route.stops,
        optimized_order: route.optimizedOrder,
        optimized_path: route.optimizedPath,
        total_distance_m: route.totalDistanceM,
        total_duration_s: route.totalDurationS,
        naive_path: route.naivePath,
        naive_distance_m: route.naiveDistanceM,
        naive_duration_s: route.naiveDurationS,
        improvement_pct: route.improvementPct,
        created_at: route.createdAt,
        cached: true
      });
    })
  );

  return router;
}

function asyncHandler(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res, next).catch(next);
  };
}
