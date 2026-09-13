import type { OptimizedRoute } from '../algorithms/route-optimizer.js';

export interface OptimizeResponse {
  optimized_order: number[];
  optimized_path: number[][];
  total_distance_m: number;
  total_duration_s: number;
  naive_path: number[][];
  naive_distance_m: number;
  naive_duration_s: number;
  improvement_pct: number;
  cached: boolean;
}

export function optimizedRouteResponse(result: OptimizedRoute): OptimizeResponse {
  return {
    optimized_order: result.optimizedOrder,
    optimized_path: result.optimizedPath.map(({ lat, lng }) => [lat, lng]),
    total_distance_m: result.totalDistanceM,
    total_duration_s: result.totalDurationS,
    naive_path: result.naivePath.map(({ lat, lng }) => [lat, lng]),
    naive_distance_m: result.naiveDistanceM,
    naive_duration_s: result.naiveDurationS,
    improvement_pct: improvementPercentage(result.naiveDistanceM, result.totalDistanceM),
    cached: false
  };
}

function improvementPercentage(naiveDistanceM: number, optimizedDistanceM: number) {
  if (naiveDistanceM === 0) {
    return 0;
  }

  return Math.round(((naiveDistanceM - optimizedDistanceM) / naiveDistanceM) * 1_000) / 10;
}
