import "dotenv/config";
import { mkdirSync, writeFileSync } from "fs";

// Steel serves recordings as fragmented-MP4 HLS: an init segment plus .m4s
// chunks behind presigned URLs. Concatenating them in order is a playable MP4,
// so no ffmpeg is needed.
async function main(): Promise<void> {
  const sessionId = process.argv[2];
  if (!sessionId) {
    console.error("Usage: npm run save-recording <session-id>");
    process.exit(1);
  }

  const res = await fetch(`https://api.steel.dev/v1/sessions/${sessionId}/hls`, {
    headers: { "steel-api-key": process.env.STEEL_API_KEY ?? "" },
  });
  if (!res.ok) throw new Error(`Couldn't fetch recording playlist: HTTP ${res.status} ${await res.text()}`);
  const playlist = await res.text();

  const init = playlist.match(/#EXT-X-MAP:URI="([^"]+)"/)?.[1];
  const segments = playlist.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("http"));
  if (!init || segments.length === 0) throw new Error("Recording playlist has no video segments yet — try again in a minute.");

  const parts: Buffer[] = [];
  for (const [i, url] of [init, ...segments].entries()) {
    const part = await fetch(url);
    if (!part.ok) throw new Error(`Segment ${i} failed: HTTP ${part.status}`);
    parts.push(Buffer.from(await part.arrayBuffer()));
    process.stdout.write(`\r[save-recording] Downloaded ${i}/${segments.length} segments`);
  }

  mkdirSync("recordings", { recursive: true });
  const out = `recordings/${sessionId}.mp4`;
  writeFileSync(out, Buffer.concat(parts));
  console.log(`\n[save-recording] Saved ${out} (~${segments.length * 4}s)`);
}

await main();
