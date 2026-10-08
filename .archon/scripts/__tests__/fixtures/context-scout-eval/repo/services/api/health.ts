export interface HealthReport {
  status: 'ok' | 'degraded';
  uptimeSeconds: number;
  checks: Record<string, boolean>;
}

export async function health(
  checks: Record<string, () => Promise<boolean>>,
  startedAt: number
): Promise<HealthReport> {
  const results: Record<string, boolean> = {};
  for (const [name, check] of Object.entries(checks)) {
    try {
      results[name] = await check();
    } catch {
      results[name] = false;
    }
  }
  return {
    status: Object.values(results).every(Boolean) ? 'ok' : 'degraded',
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    checks: results,
  };
}
