// A one-line-per-event channel the web server parses off the agent's stdout.
//
// Normal human-readable logging still goes to stdout untouched; these lines are
// prefixed so the server can pick them out and ignore everything else. Used
// only when the agent runs under `--web`.
export type AgentEvent =
  | { type: "status"; message: string }
  | { type: "live-view"; url: string; sessionId: string }
  | { type: "picked"; item: string; restaurant: string; price: number; macros: unknown; reasoning: string; source: string }
  | { type: "approval-request"; item: string; restaurant: string; price: number; checkoutTotal: string; macros: unknown; reasoning: string; reportPath: string | null }
  | { type: "result"; placed: boolean; message: string }
  | { type: "error"; message: string };

export const EVENT_PREFIX = "@@MACROME ";

let enabled = false;

export function enableEvents(): void {
  enabled = true;
}

export function emit(event: AgentEvent): void {
  if (!enabled) return;
  process.stdout.write(EVENT_PREFIX + JSON.stringify(event) + "\n");
}

export function eventsEnabled(): boolean {
  return enabled;
}
