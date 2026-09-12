/** Prefer Steel's viewer URL; fall back to the dashboard session page. */
export function liveViewUrl(session: { id: string; sessionViewerUrl?: string | null }): string {
  return session.sessionViewerUrl || `https://app.steel.dev/sessions/${session.id}`;
}

export function printLiveView(label: string, session: { id: string; sessionViewerUrl?: string | null }): void {
  const url = liveViewUrl(session);
  console.log("");
  console.log("=".repeat(60));
  console.log(`[${label}] Open this live browser link:`);
  console.log(url);
  console.log("=".repeat(60));
  console.log("");
}
