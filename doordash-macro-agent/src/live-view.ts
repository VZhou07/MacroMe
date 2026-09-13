/**
 * Steel exposes two different URLs for a session and they are not interchangeable:
 *
 *  - `debugUrl` (api.steel.dev/v1/sessions/<id>/player) is the live player. It is
 *    what you embed in an iframe.
 *  - `sessionViewerUrl` (app.steel.dev/sessions/<id>) is the dashboard page. It
 *    sits behind a login and sends X-Frame-Options, so framing it just shows the
 *    browser's "can't open this page" error — it is only good as a link out.
 */
export interface SessionLike {
  id: string;
  debugUrl?: string | null;
  sessionViewerUrl?: string | null;
}

/** The embeddable live view. Safe to put in an iframe. */
export function liveViewUrl(session: SessionLike): string {
  return session.debugUrl || `https://api.steel.dev/v1/sessions/${session.id}/player`;
}

/** The Steel dashboard page for this session. Link out to it; don't frame it. */
export function dashboardUrl(session: SessionLike): string {
  return session.sessionViewerUrl || `https://app.steel.dev/sessions/${session.id}`;
}

export function printLiveView(label: string, session: SessionLike): void {
  console.log("");
  console.log("=".repeat(60));
  console.log(`[${label}] Open this live browser link:`);
  console.log(liveViewUrl(session));
  console.log(`[${label}] Session details: ${dashboardUrl(session)}`);
  console.log("=".repeat(60));
  console.log("");
}
