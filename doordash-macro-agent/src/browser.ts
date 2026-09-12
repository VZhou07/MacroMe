import Steel from "steel-sdk";

const client = new Steel({ steelAPIKey: process.env.STEEL_API_KEY });

let sessionId: string | null = null;

export async function startSession(profileId: string): Promise<string> {
  const session = await client.sessions.create({
    useProxy: false,
    profileId,
    persistProfile: false,
  });
  sessionId = session.id;
  console.log(`[browser] Session started: ${session.id}`);
  console.log(`[browser] Live view: https://app.steel.dev/sessions/${session.id}`);
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
