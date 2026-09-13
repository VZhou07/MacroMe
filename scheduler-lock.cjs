// One process owns the clock.
//
// The web server runs the minute cron in-process, and `npm run schedule` still
// exists for people who'd rather run it alone. If both are up they would fire
// the same meal twice, so whichever starts first takes this lock and the other
// sits out until the holder stops (or dies and its heartbeat goes stale).
const fs = require('fs');
const path = require('path');

const LOCK_PATH = process.env.MACROME_SCHEDULER_LOCK || path.join(__dirname, 'macrome-scheduler.lock');
// Two and a half missed heartbeats: long enough that a slow tick never steals
// the lock from a healthy process, short enough that a `kill -9` frees it fast.
const STALE_MS = 150000;

function read(file = LOCK_PATH) {
  try {
    const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof lock.pid === 'number' ? lock : null;
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // Running, just not ours to signal.
  }
}

function held(lock, now) {
  return Boolean(lock) && now - Date.parse(lock.heartbeatAt) < STALE_MS && alive(lock.pid);
}

/** Who owns the cron right now, or null if it is free. */
function holder(file = LOCK_PATH, now = Date.now()) {
  const lock = read(file);
  return held(lock, now) ? lock : null;
}

function write(owner, file, now) {
  const body = JSON.stringify({ pid: process.pid, owner, host: require('os').hostname(), heartbeatAt: new Date(now).toISOString() }, null, 2);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, body);
  fs.renameSync(temporary, file);
}

/**
 * Take the cron role if nobody healthy holds it. Safe to call every minute: a
 * process that lost a race simply keeps asking and picks the job up if the
 * holder exits.
 */
function acquire(owner, file = LOCK_PATH, now = Date.now()) {
  const lock = read(file);
  if (lock && lock.pid !== process.pid && held(lock, now)) return false;
  write(owner, file, now);
  return true;
}

/** Keep the claim fresh; false means someone else took over and we must stand down. */
function heartbeat(owner, file = LOCK_PATH, now = Date.now()) {
  const lock = read(file);
  if (lock && lock.pid !== process.pid && held(lock, now)) return false;
  write(owner, file, now);
  return true;
}

function release(file = LOCK_PATH) {
  const lock = read(file);
  if (lock && lock.pid !== process.pid) return;
  try {
    fs.unlinkSync(file);
  } catch { /* already gone */ }
}

module.exports = { LOCK_PATH, STALE_MS, acquire, heartbeat, release, holder };
