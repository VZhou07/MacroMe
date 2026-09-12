import "dotenv/config";
import { createInterface } from "readline";
import { chromium } from "playwright-core";
import Steel from "steel-sdk";
import { printLiveView } from "./live-view.js";

const client = new Steel({ steelAPIKey: process.env.STEEL_API_KEY });

function waitForEnter(prompt: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, () => { rl.close(); resolve(); }));
}

async function main(): Promise<void> {
  if (!process.env.STEEL_API_KEY || process.env.STEEL_API_KEY.startsWith("your_")) {
    throw new Error("Set a real STEEL_API_KEY in doordash-macro-agent/.env before setup-profile.");
  }

  const existingProfileId = process.env.STEEL_PROFILE_ID || undefined;

  const session = await client.sessions.create({
    persistProfile: true,
    profileId: existingProfileId,
  });

  printLiveView("setup-profile", session);
  console.log(`[setup-profile] Profile id: ${session.profileId}`);

  const browser = await chromium.connectOverCDP(session.websocketUrl);
  const context = browser.contexts()[0];
  const page = context.pages()[0];

  try {
    await page.goto("https://www.doordash.com", { waitUntil: "domcontentloaded", timeout: 30000 });

    console.log("Open the live browser link above, log into DoorDash by hand (OTP/CAPTCHA in that tab),");
    console.log("then come back here.");
    await waitForEnter("Press Enter once you're fully logged in on DoorDash... ");
  } finally {
    await browser.close();
    await client.sessions.release(session.id);
    console.log(`[setup-profile] Session released — profile snapshot saved.`);
  }

  console.log(`\n[setup-profile] Save this in your .env:\nSTEEL_PROFILE_ID=${session.profileId}\n`);
}

await main();
