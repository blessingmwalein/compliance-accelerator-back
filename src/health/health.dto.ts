/** Liveness result: the process is running and able to answer requests. */
export class HealthDto {
  /** Always `ok` when the process answers. */
  status!: 'ok';

  /** Seconds since the process started. */
  uptimeSeconds!: number;
}

/** Readiness result: dependencies required to serve traffic are reachable. */
export class ReadyDto {
  /** `ok` only when every dependency check is `up`. */
  status!: 'ok';

  /** Per-dependency state. */
  checks!: { database: 'up' };
}
