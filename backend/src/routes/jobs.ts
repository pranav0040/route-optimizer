import { Router, type NextFunction, type Request, type Response } from 'express';

import { ApiError } from '../http/api-error.js';
import type { JobRepository } from '../jobs/types.js';

export function createJobRouter(repository: JobRepository) {
  const router = Router();

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const job = await repository.getJob(req.params.id);

      if (!job) {
        throw new ApiError(404, 'JOB_NOT_FOUND', `Job ${req.params.id} was not found.`);
      }

      res.json({
        job_id: job.jobId,
        status: job.status,
        ...(job.routeId ? { route_id: job.routeId } : {}),
        ...(job.errorReason ? { error_reason: job.errorReason } : {})
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
