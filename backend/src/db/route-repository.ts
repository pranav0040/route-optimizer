import { pool } from './pool.js';

export interface StoredRoute {
  id: string;
  origin: { lat: number; lng: number };
  stops: Array<{ lat: number; lng: number }>;
  optimizedOrder: number[];
  optimizedPath: number[][];
  totalDistanceM: number;
  totalDurationS: number;
  naivePath: number[][];
  naiveDistanceM: number;
  naiveDurationS: number;
  improvementPct: number;
  createdAt: string;
}

export interface RouteRepository {
  getRoute(routeId: string): Promise<StoredRoute | null>;
}

interface RouteRow {
  id: string;
  origin: StoredRoute['origin'];
  stops: StoredRoute['stops'];
  optimized_order: number[];
  optimized_path: number[][];
  total_distance_m: number | string;
  total_duration_s: number | string;
  naive_path: number[][];
  naive_distance_m: number | string;
  naive_duration_s: number | string;
  improvement_pct: number | string;
  created_at: Date | string;
}

export class PostgresRouteRepository implements RouteRepository {
  async getRoute(routeId: string): Promise<StoredRoute | null> {
    const result = await pool.query<RouteRow>(
      `
        SELECT
          id, origin, stops, optimized_order, optimized_path, total_distance_m,
          total_duration_s, naive_path, naive_distance_m, naive_duration_s,
          improvement_pct, created_at
        FROM routes
        WHERE id = $1
      `,
      [routeId]
    );
    const row = result.rows[0];

    return row
      ? {
          id: row.id,
          origin: row.origin,
          stops: row.stops,
          optimizedOrder: row.optimized_order,
          optimizedPath: row.optimized_path,
          totalDistanceM: Number(row.total_distance_m),
          totalDurationS: Number(row.total_duration_s),
          naivePath: row.naive_path,
          naiveDistanceM: Number(row.naive_distance_m),
          naiveDurationS: Number(row.naive_duration_s),
          improvementPct: Number(row.improvement_pct),
          createdAt:
            row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
        }
      : null;
  }
}
