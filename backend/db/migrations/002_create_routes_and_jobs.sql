CREATE TABLE IF NOT EXISTS routes (
  id UUID PRIMARY KEY,
  origin JSONB NOT NULL,
  stops JSONB NOT NULL,
  algorithm TEXT NOT NULL,
  optimized_order JSONB NOT NULL,
  total_distance_m DOUBLE PRECISION NOT NULL CHECK (total_distance_m >= 0),
  total_duration_s DOUBLE PRECISION NOT NULL CHECK (total_duration_s >= 0),
  naive_distance_m DOUBLE PRECISION NOT NULL CHECK (naive_distance_m >= 0),
  naive_duration_s DOUBLE PRECISION NOT NULL CHECK (naive_duration_s >= 0),
  improvement_pct DOUBLE PRECISION NOT NULL,
  cache_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS routes_cache_key_idx ON routes (cache_key);

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  input_payload JSONB NOT NULL,
  route_id UUID REFERENCES routes(id) ON DELETE SET NULL,
  error_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status);
