import type { DayLogEntry, DayLogStatus } from './day-log.cjs';
export interface Macros { calories: number; protein: number; carbs: number; fat: number }
export interface DigestMeal {
  meal: string; status: DayLogStatus; at: string; eatAt: string | null;
  item: string | null; restaurant: string | null; macros: Macros | null; source: string | null;
  checkoutTotal: string | null; note: string | null; dryRun: boolean;
}
export interface Digest {
  date: string; timezone: string; generatedAt: string;
  targets: Macros; totals: Macros; remaining: Macros;
  spend: { amount: number; currency: string; orders: number };
  counts: Record<DayLogStatus, number>;
  meals: DigestMeal[];
  summary: string;
}
export interface DigestPlan { timezone?: string; digestTime?: string; macros?: Macros; meals?: { time: string }[]; schedule?: { day: string; time: string }[] }
export interface DigestOptions { file?: string; dayLogFile?: string; now?: Date }
export declare const DIGEST_PATH: string;
export function buildDigest(plan: DigestPlan, date: string, entries: DayLogEntry[], now?: Date): Digest;
export function generateDigest(plan: DigestPlan, date: string, options?: DigestOptions): Digest;
export function ensureDigests(plan: DigestPlan, now?: Date, options?: DigestOptions): Digest[];
export function readDigests(file?: string): Record<string, Digest>;
export function getDigest(date: string, file?: string): Digest | null;
export function listDigests(file?: string, limit?: number): Digest[];
export function writeDigest(digest: Digest, file?: string): Digest;
export function digestTime(plan: DigestPlan, date?: string): string;
export function digestDueAt(plan: DigestPlan, date: string): Date | null;
export function parseMoney(total: string | null): { amount: number; currency: string } | null;
export function today(plan: DigestPlan, now?: Date): string;
