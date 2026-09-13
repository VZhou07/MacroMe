export interface SchedulerLock { pid: number; owner: string; host: string; heartbeatAt: string }
export declare const LOCK_PATH: string;
export declare const STALE_MS: number;
export function acquire(owner: string, file?: string, now?: number): boolean;
export function heartbeat(owner: string, file?: string, now?: number): boolean;
export function release(file?: string): void;
export function holder(file?: string, now?: number): SchedulerLock | null;
