export declare const DAYS: readonly string[];
export function dateParts(date: Date, timezone: string): Record<string, number>;
export function wallTime(parts: Record<string, number>): number;
export function atTime(date: Date, time: string, timezone: string): Date | null;
export function localDate(date: Date, timezone: string): string;
export function dateKeyToUtc(dateKey: string): Date;
export function instantAt(dateKey: string, time: string, timezone: string): Date | null;
export function shiftDateKey(dateKey: string, days: number): string;
