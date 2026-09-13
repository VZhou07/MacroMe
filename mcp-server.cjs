#!/usr/bin/env node
// MacroMe as MCP tools, for developers who live in an IDE.
//
// Optional: the website and the cron do not need this, and it does not keep
// anything running. It is a thin read-mostly view over the same day log and
// digest files the dashboard uses, so an agent in Cursor can ask "how did today
// go" without importing our TypeScript or scraping the UI.
//
// stdio transport: every byte on stdout belongs to the protocol, so diagnostics
// go to stderr only.
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: [path.join(__dirname, '.env'), path.join(__dirname, 'doordash-macro-agent/.env')], quiet: true });
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const dayLog = require('./day-log.cjs');
const digests = require('./digest.cjs');
const email = require('./digest-email.cjs');

const CONFIG_PATH = process.env.MACROME_CONFIG || path.join(__dirname, 'macrome-config.json');
const DATE_ARG = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');

function loadPlan() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    throw new Error(err.code === 'ENOENT'
      ? `No MacroMe plan at ${CONFIG_PATH}. Run \`npm run dev\` and finish the onboarding first.`
      : `Could not read ${CONFIG_PATH}: ${err.message}`);
  }
}

const text = (body) => ({ content: [{ type: 'text', text: body }] });
const failure = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

/** The saved digest for a date, or today's so far if it hasn't been written yet. */
function digestFor(plan, date) {
  const saved = digests.getDigest(date);
  return {
    digest: saved || digests.buildDigest(plan, date, dayLog.entriesForDate(date)),
    final: Boolean(saved),
  };
}

const server = new McpServer({ name: 'macrome', version: '1.0.0' });

server.registerTool('get_today_summary', {
  title: "Today's MacroMe summary",
  description: 'Macros against target, spend, and every meal placed, declined, failed or missed for a day. '
    + "Defaults to today in the plan's timezone. Before the end-of-day digest is written this is the running total.",
  inputSchema: { date: DATE_ARG.optional().describe('Day to summarise, YYYY-MM-DD. Defaults to today.') },
}, async ({ date }) => {
  try {
    const plan = loadPlan();
    const day = date || digests.today(plan);
    const { digest, final } = digestFor(plan, day);
    return text(`${email.renderText(digest)}\n\n${final ? 'This is the saved end-of-day digest.' : `Still in progress — the digest is written at ${digests.digestTime(plan)} ${digest.timezone}.`}`);
  } catch (err) {
    return failure(err.message);
  }
});

server.registerTool('list_digests', {
  title: 'Past MacroMe digests',
  description: 'Saved end-of-day digests, newest first, as one line per day.',
  inputSchema: { limit: z.number().int().min(1).max(90).optional().describe('How many days to return. Defaults to 14.') },
}, async ({ limit }) => {
  try {
    loadPlan();
    const saved = digests.listDigests(undefined, limit || 14);
    if (!saved.length) return text('No digests have been written yet.');
    return text(saved.map((digest) => `${digest.date} — ${digest.summary}`).join('\n'));
  } catch (err) {
    return failure(err.message);
  }
});

server.registerTool('send_eod_digest', {
  title: 'Email a MacroMe digest',
  description: 'Write a day\'s digest from the day log and email it to DIGEST_EMAIL. '
    + 'Needs RESEND_API_KEY and DIGEST_EMAIL; without them it reports the digest without sending.',
  inputSchema: { date: DATE_ARG.optional().describe('Day to send, YYYY-MM-DD. Defaults to today.') },
}, async ({ date }) => {
  try {
    const plan = loadPlan();
    const digest = digests.generateDigest(plan, date || digests.today(plan));
    const result = await email.sendDigest(digest);
    return text(`${digest.date}: ${digest.summary}\n\n${result.sent ? `Emailed to ${process.env.DIGEST_EMAIL}.` : `Not emailed — ${result.reason}. The digest is still saved and on the dashboard.`}`);
  } catch (err) {
    return failure(err.message);
  }
});

server.connect(new StdioServerTransport()).then(
  () => console.error('[mcp] MacroMe tools ready on stdio.'),
  (err) => { console.error('[mcp] Could not start:', err); process.exitCode = 1; },
);
