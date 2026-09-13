import cors from 'cors';
import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import { ZodError } from 'zod';

import type { RoadGraph } from './graph/road-graph.js';
import { ApiError } from './http/api-error.js';
import type { JobRepository } from './jobs/types.js';
import { apiLogger } from './logging/logger.js';
import { createJobRouter } from './routes/jobs.js';
import { createRouteRouter, type RouteRouterOptions } from './routes/routes.js';

export interface CreateAppOptions extends RouteRouterOptions {
  graph?: RoadGraph;
  jobRepository?: JobRepository;
}

export function createApp(options: CreateAppOptions = {}) {
  const app = express();
  const trustProxyHops = nonNegativeIntegerEnvironmentValue('TRUST_PROXY_HOPS', 0);

  if (trustProxyHops > 0) {
    app.set('trust proxy', trustProxyHops);
  }

  app.use(express.json());
  app.use(cors({ origin: process.env.CORS_ORIGIN ?? true }));
  app.use(
    pinoHttp({
      logger: apiLogger,
      enabled: process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true'
    })
  );

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: positiveIntegerEnvironmentValue('RATE_LIMIT_MAX', 100),
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_req, res) => {
        res.status(429).json({
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Too many requests; try again in one minute.'
          }
        });
      }
    })
  );

  app.use('/api/routes', createRouteRouter(options));

  if (options.jobRepository) {
    app.use('/api/jobs', createJobRouter(options.jobRepository));
  }

  const errorHandler: ErrorRequestHandler = (error: unknown, req, res, _next) => {
    void _next;

    if (error instanceof SyntaxError && 'status' in error && error.status === 400) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request body must contain valid JSON.'
        }
      });
      return;
    }

    if (error instanceof ZodError) {
      const issue = error.issues[0];
      const field = issue?.path.join('.') || 'body';

      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: `${field}: ${issue?.message ?? 'Invalid request body'}`
        }
      });
      return;
    }

    if (error instanceof ApiError) {
      res.status(error.status).json({
        error: { code: error.code, message: error.message }
      });
      return;
    }

    req.log.error({ err: error }, 'Unhandled API error');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' }
    });
  };

  app.use(errorHandler);

  return app;
}

function positiveIntegerEnvironmentValue(name: string, fallback: number) {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const value = Number(rawValue);

  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }

  return value;
}

function nonNegativeIntegerEnvironmentValue(name: string, fallback: number) {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const value = Number(rawValue);

  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer.`);
  }

  return value;
}
