import type Steel from 'steel-sdk';

// Launch's documented maximum is safe across current cloud plans. Higher
// limits require a matching Steel plan; never silently clamp an explicit value.
export const DEFAULT_SESSION_TIMEOUT_MINUTES = 15;

export function sessionTimeoutMs(value = process.env.MACROME_SESSION_TIMEOUT_MINUTES): number {
  const minutes = value === undefined ? DEFAULT_SESSION_TIMEOUT_MINUTES : Number(value);
  const milliseconds = minutes * 60000;
  if (!Number.isFinite(minutes) || minutes <= 0 || !Number.isSafeInteger(milliseconds)) {
    throw new Error('MACROME_SESSION_TIMEOUT_MINUTES must be a positive number of minutes.');
  }
  return milliseconds;
}

/** Create a browser with a verified lifetime, without an inactivity cutoff. */
export async function createSession(
  client: Steel,
  options: Steel.SessionCreateParams = {},
): Promise<Steel.Session> {
  const timeout = sessionTimeoutMs();
  // Omit inactivityTimeout: Steel documents inactivity release as off by default.
  const session = await client.sessions.create({ ...options, timeout });
  if (!Number.isFinite(session.timeout) || session.timeout < timeout) {
    await client.sessions.release(session.id);
    throw new Error(`Steel granted a ${session.timeout / 60000}-minute session, shorter than the requested ${timeout / 60000} minutes. Check your Steel plan's session limit; MacroMe will not silently use a shorter session.`);
  }
  console.log(`[steel] Session lifetime: ${session.timeout / 60000} minutes (requested ${timeout / 60000}).`);
  return session;
}
