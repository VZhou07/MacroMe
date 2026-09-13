export interface ScheduledOrder {
  id: string;
  meal: string;
  time: string;
  eatAt: string;
  orderAt: string;
  addressId: string;
}
export interface QueuePlan {
  timezone?: string;
  days: string[];
  orderLeadMinutes?: number;
  schedule: { day: string; meal: string; time: string; orderAt?: string; addressId: string }[];
}
export interface QueueState {
  completed: Set<string>;
  missed: Set<string>;
  attempted: Set<string>;
  lastSeenAt: string | null;
}
export declare const STATE_PATH: string;
export function upcomingOrders(plan: QueuePlan, completed?: Set<string>, now?: Date, limit?: number): ScheduledOrder[];
export function occurrencesBetween(plan: QueuePlan, from: Date, to: Date): ScheduledOrder[];
export function readState(file?: string): QueueState;
export function writeState(state: QueueState, file?: string, now?: Date): void;
export function readExcluded(file?: string): Set<string>;
export function readCompleted(file?: string): Set<string>;
export function markCompleted(id: string, file?: string): void;
export function markMissed(id: string, file?: string): void;
export function markAttempted(id: string, file?: string): void;
export function reconcileMissed(plan: QueuePlan, now?: Date, file?: string): ScheduledOrder[];
