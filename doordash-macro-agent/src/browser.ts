import Steel from "steel-sdk";
import { printLiveView } from "./live-view.js";

const client = new Steel({ steelAPIKey: process.env.STEEL_API_KEY });

let sessionId: string | null = null;

export async function startSession(profileId: string): Promise<string> {
  const session = await client.sessions.create({
    useProxy: false,
    profileId,
    persistProfile: false,
  });
  sessionId = session.id;
  printLiveView("browser", session);
  return session.id;
}

export async function stopSession(): Promise<void> {
  if (!sessionId) return;
  await client.sessions.release(sessionId);
  console.log(`[browser] Session released: ${sessionId}`);
  sessionId = null;
}

export function getSessionId(): string {
  if (!sessionId) throw new Error("No active Steel session");
  return sessionId;
}

export { client };
