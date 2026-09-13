import pino from 'pino';

export function createLogger(service: string) {
  return pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie'],
      censor: '[redacted]'
    }
  });
}

export const apiLogger = createLogger('route-optimizer-api');
export const workerLogger = createLogger('route-optimizer-worker');
