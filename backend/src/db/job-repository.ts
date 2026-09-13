import { randomUUID } from 'node:crypto';

import { pool } from './pool.js';
import type { OptimizedRoute } from '../algorithms/route-optimizer.js';
import type {
  JobRepository,
  JobStatus,
  JobStatusRecord,
  OptimizationJobData
} from '../jobs/types.js';

interface JobRow {
  id: string;
  status: JobStatus;
  route_id: string | null;
  error_reason: string | null;
}

export class PostgresJobRepository implements JobRepository {
  async createJob(jobId: string, data: OptimizationJobData) {
    await pool.query(`INSERT INTO jobs (id, status, input_payload) VALUES ($1, 'queued', $2)`, [
      jobId,
      JSON.stringify(data)
    ]);
  }

  async getJob(jobId: string): Promise<JobStatusRecord | null> {
    const result = await pool.query<JobRow>(
      'SELECT id, status, route_id, error_reason FROM jobs WHERE id = $1',
      [jobId]
    );
    const row = result.rows[0];

    return row
      ? {
          jobId: row.id,
          status: row.status,
          routeId: row.route_id,
          errorReason: row.error_reason
        }
      : null;
  }

  async markProcessing(jobId: string) {
    await pool.query(`UPDATE jobs SET status = 'processing', error_reason = NULL WHERE id = $1`, [
      jobId
    ]);
  }

  async markQueued(jobId: string) {
    await pool.query(`UPDATE jobs SET status = 'queued' WHERE id = $1`, [jobId]);
  }

  async completeJob(jobId: string, data: OptimizationJobData, result: OptimizedRoute) {
    const routeId = randomUUID();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(
        `
          INSERT INTO routes (
            id, origin, stops, algorithm, optimized_order, optimized_path, total_distance_m,
            total_duration_s, naive_path, naive_distance_m, naive_duration_s, improvement_pct,
            cache_key
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        `,
        [
          routeId,
          JSON.stringify(data.origin),
          JSON.stringify(data.stops),
          'nearest-neighbor-2opt-astar',
          JSON.stringify(result.optimizedOrder),
          JSON.stringify(result.optimizedPath),
          result.totalDistanceM,
          result.totalDurationS,
          JSON.stringify(result.naivePath),
          result.naiveDistanceM,
          result.naiveDurationS,
          improvementPercentage(result.naiveDistanceM, result.totalDistanceM),
          data.cacheKey
        ]
      );
      await client.query(
        `
          UPDATE jobs
          SET status = 'completed', route_id = $2, error_reason = NULL, completed_at = NOW()
          WHERE id = $1
        `,
        [jobId, routeId]
      );
      await client.query('COMMIT');
      return routeId;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async failJob(jobId: string, reason: string) {
    await pool.query(
      `
        UPDATE jobs
        SET status = 'failed', error_reason = $2, completed_at = NOW()
        WHERE id = $1
      `,
      [jobId, reason]
    );
  }
}

function improvementPercentage(naiveDistanceM: number, optimizedDistanceM: number) {
  if (naiveDistanceM === 0) {
    return 0;
  }

  return Math.round(((naiveDistanceM - optimizedDistanceM) / naiveDistanceM) * 1_000) / 10;
}
