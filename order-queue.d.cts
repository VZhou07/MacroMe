export interface ScheduledOrder {
  id: string;
  meal: string;
  time: string;
  eatAt: string;
  orderAt: string;
  addressId: string;
}
export function upcomingOrders(plan: {
  timezone?: string;
  days: string[];
  orderLeadMinutes?: number;
  schedule: { day: string; meal: string; time: string; orderAt?: string; addressId: string }[];
}, completed?: Set<string>, now?: Date, limit?: number): ScheduledOrder[];
export function readCompleted(file?: string): Set<string>;
export function markCompleted(id: string, file?: string): void;
