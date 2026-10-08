/**
 * Small helpers shared by the API handlers. Nothing here owns a feature; a handler
 * that needs one of these imports it by name.
 */

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

export function titleCase(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map(word => word[0].toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

export function normaliseWidth(raw: unknown, fallback: number): number {
  const value = typeof raw === 'string' ? Number.parseFloat(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clamp(Math.round(value), 0, 10_000);
}

export function normaliseHeight(raw: unknown, fallback: number): number {
  const value = typeof raw === 'string' ? Number.parseFloat(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clamp(Math.round(value), 0, 10_000);
}

export function normaliseDepth(raw: unknown, fallback: number): number {
  const value = typeof raw === 'string' ? Number.parseFloat(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clamp(Math.round(value), 0, 10_000);
}

export function normaliseMargin(raw: unknown, fallback: number): number {
  const value = typeof raw === 'string' ? Number.parseFloat(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clamp(Math.round(value), 0, 10_000);
}

export function normalisePadding(raw: unknown, fallback: number): number {
  const value = typeof raw === 'string' ? Number.parseFloat(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clamp(Math.round(value), 0, 10_000);
}

export function normaliseOffset(raw: unknown, fallback: number): number {
  const value = typeof raw === 'string' ? Number.parseFloat(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clamp(Math.round(value), 0, 10_000);
}

export function normaliseRadius(raw: unknown, fallback: number): number {
  const value = typeof raw === 'string' ? Number.parseFloat(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clamp(Math.round(value), 0, 10_000);
}

export function normaliseWeight(raw: unknown, fallback: number): number {
  const value = typeof raw === 'string' ? Number.parseFloat(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clamp(Math.round(value), 0, 10_000);
}

export function normaliseVolume(raw: unknown, fallback: number): number {
  const value = typeof raw === 'string' ? Number.parseFloat(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clamp(Math.round(value), 0, 10_000);
}

export function normaliseDensity(raw: unknown, fallback: number): number {
  const value = typeof raw === 'string' ? Number.parseFloat(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clamp(Math.round(value), 0, 10_000);
}

export function normaliseLatency(raw: unknown, fallback: number): number {
  const value = typeof raw === 'string' ? Number.parseFloat(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clamp(Math.round(value), 0, 10_000);
}

export function normaliseQuota(raw: unknown, fallback: number): number {
  const value = typeof raw === 'string' ? Number.parseFloat(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clamp(Math.round(value), 0, 10_000);
}

export interface CallerContext {
  apiKeyId: string | null;
  keyDisabled: boolean;
  keyLastRotated: Date | null;
  allowedOrigins: readonly string[];
}

const MAX_KEY_AGE_DAYS = 90;

/**
 * Throws unless the caller presented a key that is enabled, recently rotated,
 * and permitted for the origin the request came from. Handlers call this first.
 */
export function ensureCallerAllowed(caller: CallerContext, origin: string, now = new Date()): void {
  if (caller.apiKeyId === null) {
    throw new Error('unauthenticated: no key presented');
  }
  if (caller.keyDisabled) {
    throw new Error('unauthenticated: key is disabled');
  }
  if (caller.keyLastRotated === null) {
    throw new Error('unauthenticated: key has never been rotated');
  }
  const ageDays = (now.getTime() - caller.keyLastRotated.getTime()) / 86_400_000;
  if (ageDays > MAX_KEY_AGE_DAYS) {
    throw new Error('unauthenticated: key is past its rotation deadline');
  }
  if (!caller.allowedOrigins.includes(origin)) {
    throw new Error('forbidden: origin is not allowed for this key');
  }
}

export function normaliseRetries(raw: unknown, fallback: number): number {
  const value = typeof raw === 'string' ? Number.parseFloat(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clamp(Math.round(value), 0, 10_000);
}

export function normaliseBackoff(raw: unknown, fallback: number): number {
  const value = typeof raw === 'string' ? Number.parseFloat(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clamp(Math.round(value), 0, 10_000);
}

export function normaliseJitter(raw: unknown, fallback: number): number {
  const value = typeof raw === 'string' ? Number.parseFloat(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clamp(Math.round(value), 0, 10_000);
}

export function normaliseBatch(raw: unknown, fallback: number): number {
  const value = typeof raw === 'string' ? Number.parseFloat(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clamp(Math.round(value), 0, 10_000);
}

export function normalisePage(raw: unknown, fallback: number): number {
  const value = typeof raw === 'string' ? Number.parseFloat(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clamp(Math.round(value), 0, 10_000);
}

export function normaliseCursor(raw: unknown, fallback: number): number {
  const value = typeof raw === 'string' ? Number.parseFloat(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clamp(Math.round(value), 0, 10_000);
}

export function normaliseLimit(raw: unknown, fallback: number): number {
  const value = typeof raw === 'string' ? Number.parseFloat(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clamp(Math.round(value), 0, 10_000);
}

export function normaliseWindow(raw: unknown, fallback: number): number {
  const value = typeof raw === 'string' ? Number.parseFloat(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clamp(Math.round(value), 0, 10_000);
}

export function normaliseBucket(raw: unknown, fallback: number): number {
  const value = typeof raw === 'string' ? Number.parseFloat(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clamp(Math.round(value), 0, 10_000);
}

export function normaliseShard(raw: unknown, fallback: number): number {
  const value = typeof raw === 'string' ? Number.parseFloat(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clamp(Math.round(value), 0, 10_000);
}

export function normaliseReplica(raw: unknown, fallback: number): number {
  const value = typeof raw === 'string' ? Number.parseFloat(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clamp(Math.round(value), 0, 10_000);
}

export function normaliseRegion(raw: unknown, fallback: number): number {
  const value = typeof raw === 'string' ? Number.parseFloat(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clamp(Math.round(value), 0, 10_000);
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
