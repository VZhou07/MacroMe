import type { QueuePlan, ScheduledOrder } from './order-queue.cjs';
import type { DayLogEntry } from './day-log.cjs';
import type { Digest, DigestPlan } from './digest.cjs';
export interface TickResult {
  minute: string;
  missed: DayLogEntry[];
  fired: ScheduledOrder[];
  digests: Digest[];
}
export interface TickOptions {
  plan: QueuePlan & DigestPlan;
  runOrder: (occurrence: ScheduledOrder) => unknown | Promise<unknown>;
  canRun?: (occurrence: ScheduledOrder) => boolean;
  now?: Date;
  queueFile?: string;
  dayLogFile?: string;
  file?: string;
}
export interface TickerOptions extends Omit<TickOptions, 'plan' | 'now'> {
  loadPlan: () => (QueuePlan & DigestPlan) | null;
  owner?: string;
  onTick?: (result: TickResult) => void;
  onError?: (err: unknown) => void;
  log?: (message: string) => void;
}
export declare const OFFLINE_NOTE: string;
export declare const BUSY_NOTE: string;
export function tick(options: TickOptions): Promise<TickResult>;
export function startTicker(options: TickerOptions): { stop(): void; ready: Promise<void>; tick(): Promise<void> };
