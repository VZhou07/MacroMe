export type DayLogStatus = 'placed' | 'declined' | 'failed' | 'missed';
export interface DayLogEntry {
  id: string | null;
  date: string;
  timezone: string;
  meal: string;
  status: DayLogStatus;
  at: string;
  eatAt: string | null;
  pick: {
    item: string; restaurant: string; price: number;
    macros: { calories: number; protein: number; carbs: number; fat: number };
    source?: string; reasoning?: string;
  } | null;
  cartItems: { name: string; quantity: number; linePrice: string; modifiers: string[] }[] | null;
  checkoutTotal: string | null;
  note: string | null;
  dryRun: boolean;
}
export declare const LOG_PATH: string;
export declare const STATUSES: DayLogStatus[];
export function appendEntry(entry: Partial<DayLogEntry>, file?: string, now?: Date): DayLogEntry;
export function readEntries(file?: string): DayLogEntry[];
export function entriesForDate(date: string, file?: string): DayLogEntry[];
export function datesWithEntries(file?: string): string[];
