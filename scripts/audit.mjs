#!/usr/bin/env node
// Audit every Exploded figure on a page in headless Chrome, with no dependencies.
//
//   node scripts/audit.mjs <file.html | url> [--out dir] [--width 1440] [--theme light|dark]
//
// For each figure it prints the layer stack per state, runs the runtime's audit
// (every paint claimed by exactly one layer, every layer's clone laid out to
// within 0.5 px of the live component, in every state) and saves a PNG of the
// card apart and together. Exits 1 if any figure fails or the page logs errors.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : d; };
const target = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
if (!target) { console.log("usage: node scripts/audit.mjs <file.html | url> [--out dir] [--width 1440] [--theme light|dark]"); process.exit(2); }
const url = /^https?:|^file:/.test(target) ? target : pathToFileURL(resolve(target)).href;
const out = resolve(opt("--out", "shots"));
const width = Number(opt("--width", 1440));
mkdirSync(out, { recursive: true });

const CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Aside.app/Contents/MacOS/Aside",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].filter(Boolean);
const chrome = CANDIDATES.find((p) => existsSync(p));
if (!chrome) { console.error("No Chrome found. Set CHROME_PATH to a Chrome or Chromium binary."); process.exit(2); }

// Aside replays its first-run flow (closing and reopening the window) on every fresh profile,
// so it keeps one audit profile across runs; other browsers get a throwaway one.
const aside = /Aside/.test(chrome);
const profile = aside ? join(tmpdir(), "xp-audit-aside-profile") : mkdtempSync(join(tmpdir(), "xp-audit-"));
// A browser left over from an interrupted run would hold that profile: stop it (only ours use this path).
if (aside) try { execFileSync("pkill", ["-9", "-f", `user-data-dir=${profile}`]); } catch (_) { /* none running */ }
// Saved sessions would be restored into the background on launch, and pile up: start clean.
if (aside) rmSync(join(profile, "Default", "Sessions"), { recursive: true, force: true });
// An explicit free port: Aside (Chromium) fails to serve DevTools on port 0, and its
// onboarding extension replaces the tab unless extensions are disabled.
const port = await new Promise((ok) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const proc = spawn(chrome, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--hide-scrollbars", "--force-device-scale-factor=2", "--no-first-run", "--disable-extensions", "--allow-file-access-from-files",
  // A headless window counts as hidden: without these its frames and timers get throttled to a crawl.
  "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const stop = (sig) => { try { proc.kill(sig); } catch (_) { /* gone */ } };
// Any error from here on still shuts the browser down instead of leaving it running.
let closing = false;
const fatal = (e) => { if (closing) return; console.error(e?.message || e); cleanup(1); };
process.on("unhandledRejection", fatal);
process.on("uncaughtException", fatal);
const wsUrl = await new Promise((ok, fail) => {
  let buf = "";
  const slow = setTimeout(() => { stop("SIGKILL"); fail(new Error("Chrome did not start")); }, 15000);
  proc.stderr.on("data", (d) => { buf += d; const m = buf.match(new RegExp(`DevTools listening on (ws://127\\.0\\.0\\.1:${port}/\\S+)`)); if (m) { clearTimeout(slow); ok(m[1]); } });
});

const ws = new WebSocket(wsUrl);
await new Promise((ok) => ws.addEventListener("open", ok, { once: true }));
ws.addEventListener("close", () => { if (!closing) for (const [id, p] of pending) { pending.delete(id); p.fail(new Error("The browser closed the connection. Run it again.")); } });
let seq = 0;
const pending = new Map();
const listeners = [];
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { const { ok, fail } = pending.get(msg.id); pending.delete(msg.id); msg.error ? fail(new Error(msg.error.message)) : ok(msg.result); }
  // A detached session never answers its in-flight calls: fail them so the caller can reattach.
  else if (msg.method === "Target.detachedFromTarget") for (const [id, p] of pending) if (p.sessionId === msg.params.sessionId) { pending.delete(id); p.fail(new Error("Session with given id not found.")); }
  else for (const l of listeners) l(msg);
});
const send = (method, params = {}, sessionId) => new Promise((ok, fail) => { const id = ++seq; pending.set(id, { ok, fail, sessionId }); ws.send(JSON.stringify({ id, method, params, sessionId })); });

// A browser that stops answering (Aside's first run can) fails the audit instead of hanging it.
setTimeout(() => { console.error("Audit timed out after 5 minutes: the browser stopped responding. Run it again."); cleanup(1); }, 300000);
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
let { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
const logs = [];
listeners.push((m) => {
  if (m.sessionId !== sessionId) return;
  if (m.method === "Runtime.exceptionThrown") logs.push("exception: " + m.params.exceptionDetails.exception?.description);
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") logs.push("console.error: " + m.params.args.map((a) => a.value ?? a.description).join(" "));
});
// Reduced motion makes every pose land at once, so shots are deterministic.
const features = [{ name: "prefers-reduced-motion", value: "reduce" }];
if (opt("--theme")) features.push({ name: "prefers-color-scheme", value: opt("--theme") });
const setup = async () => {
  await S("Runtime.enable");
  await S("Page.enable");
  await S("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 2, mobile: false });
  await S("Emulation.setEmulatedMedia", { features });
};
await setup();
await S("Page.navigate", { url });
// Aside's first-run flow closes the window and reopens it, with our page or only a new tab:
// follow it to the new target and load the page there again.
const reattach = async () => {
  const pages = (await send("Target.getTargets")).targetInfos.filter((x) => x.type === "page" && !x.attached);
  const t = pages.find((x) => x.url === url) || pages.find((x) => /^(chrome:\/\/newtab|about:blank)/.test(x.url));
  if (!t) return;
  ({ sessionId } = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true }));
  await setup();
  await S("Page.navigate", { url });
};

const evaluate = async (expression) => {
  const r = await S("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "evaluate failed");
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let count = 0;
// Capture is async (every state settles first), so give mounting up to a minute.
for (let i = 0; i < 400; i++) {
  await sleep(150);
  count = await evaluate(`(document.fonts ? document.fonts.ready : Promise.resolve()).then(() => { const h = [...document.querySelectorAll('.xp')]; return h.length && h.every((x) => x.exploded) ? h.length : 0; })`)
    .catch((e) => (/Session with given id not found/.test(e.message) ? reattach().then(() => 0) : 0));
  if (count) break;
}
if (!count) {
  console.error("No Exploded figures mounted on the page.");
  const { targetInfos } = await send("Target.getTargets");
  targetInfos.filter((t) => t.type === "page").forEach((t) => console.error(`  open page: ${t.url}${t.attached ? " (attached)" : ""}`)); logs.forEach((l) => console.error("  " + l)); cleanup(1); await new Promise(() => {}); }

let failed = 0;
for (let i = 0; i < count; i++) {
  const report = await evaluate(`(() => { const h = document.querySelectorAll('.xp')[${i}]; const a = h.exploded.audit(); return { title: h.querySelector('.xp-tr').textContent, audit: a, model: h.exploded.model() }; })()`);
  const ok = report.audit.ok;
  if (!ok) failed++;
  console.log(`\nFig ${i + 1} · ${report.title} · ${ok ? "audit passed" : "AUDIT FAILED"} · ${report.audit.checked} checks`);
  for (const m of report.model) console.log(`  ${m.state.padEnd(10)} ${m.w}×${m.h}  ${m.layers.map((l) => `${l.name}: ${l.summary}`).join("  |  ")}`);
  for (const p of report.audit.problems.slice(0, 30)) console.log("  ✗ " + p);
  for (const m of report.model) if (!m.settled) console.log(`  ⚠ ${m.state} never settled while captured: it animates on its own, so the sheets hold one moment of it`);
  const pix = await pixelCheck(i, report.model.map((m) => m.state), report.model.map((m) => m.settled));
  if (!pix.ok) failed++;
  console.log(`  pixels ${pix.ok ? "match" : "DIFFER"} · ${pix.note}`);
  for (const pose of ["apart", "together"]) {
    const box = await evaluate(`(async () => { const h = document.querySelectorAll('.xp')[${i}]; h.scrollIntoView({ block: 'center' }); h.exploded.apart(${pose === "apart"}); await new Promise((r) => setTimeout(r, 900)); const b = h.querySelector('.xp-card').getBoundingClientRect(); return { x: b.x + scrollX, y: b.y + scrollY, width: b.width, height: b.height }; })()`);
    const shot = await S("Page.captureScreenshot", { format: "png", clip: { ...box, scale: 1 }, captureBeyondViewport: false });
    const file = join(out, `fig-${i + 1}-${pose}.png`);
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    console.log(`  shot  ${file}`);
  }
}
if (logs.length) { console.log("\nPage errors:"); logs.forEach((l) => console.log("  " + l)); }
console.log(`\n${failed || logs.length ? "FAILED" : "passed"} · ${count} figure${count > 1 ? "s" : ""}`);
cleanup(failed || logs.length ? 1 : 0);

// Pixel check, for every state: put the live component in the state (api.pose), then shoot it
// and the state's layers stacked flat at zoom 1 (api.composite) on the same white backdrop.
// Paint the clones lose or get wrong (a canvas, a placeholder colour, a missed layer) shows here
// even when audit() passes. A pixel differs when a channel is off by more than 32/255; a state
// fails when more than 0.5% and more than 200 device pixels differ, so a few anti-aliased edges
// on a tiny component don't fail it.
async function pixelCheck(i, states, captured) {
  const fig = `document.querySelectorAll('.xp')[${i}]`;
  const rect = (el) => `(() => { const b = (${el}).getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`;
  const shoot = async (box, name) => {
    const shot = await S("Page.captureScreenshot", { format: "png", clip: { ...box, scale: 1 }, captureBeyondViewport: false });
    writeFileSync(join(out, `fig-${i + 1}-pixels-${name}.png`), Buffer.from(shot.data, "base64"));
    return shot.data;
  };
  const diff = (a, b) => evaluate(`(async () => {
    const load = (s) => new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = no; im.src = 'data:image/png;base64,' + s; });
    const [a, b] = await Promise.all([load(${JSON.stringify(a)}), load(${JSON.stringify(b)})]);
    const px = (im) => { const c = document.createElement('canvas'); c.width = a.width; c.height = a.height; const x = c.getContext('2d'); x.drawImage(im, 0, 0); return x.getImageData(0, 0, a.width, a.height).data; };
    const p = px(a), q = px(b); let bad = 0;
    for (let k = 0; k < p.length; k += 4) if (Math.max(Math.abs(p[k] - q[k]), Math.abs(p[k + 1] - q[k + 1]), Math.abs(p[k + 2] - q[k + 2])) > 32) bad++;
    return { ratio: bad / (a.width * a.height), bad };
  })()`);
  // A fixed white cover inside the specimen slot, so a component that inherits its font or colour keeps them.
  await evaluate(`(() => {
    const spec = ${fig}.querySelector('.xp-specimen'), cover = document.createElement('div'), box = document.createElement('div');
    cover.id = 'xp-pix'; cover.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#fff';
    box.style.cssText = 'position:relative;width:' + spec.clientWidth + 'px';
    cover.appendChild(box); spec.appendChild(cover); window.scrollTo(0, 0); document.activeElement?.blur();
    // Behind the cover the 3D figures would still be rendered for every shot: hide them meanwhile.
    for (const v of document.querySelectorAll('.xp-viewport')) v.style.visibility = 'hidden';
    window.__xpPix = { spec, cover, box, t: spec.firstElementChild };
  })()`);
  // Sheets are stacked by kind of paint, so a component with its own 3D depth can't be restacked exactly.
  const is3d = await evaluate(`[window.__xpPix.t, ...window.__xpPix.t.querySelectorAll('*')].some((e) => getComputedStyle(e).transformStyle === 'preserve-3d')`);
  const results = [];
  try {
    for (let s = 0; s < states.length; s++) {
      const liveBox = await evaluate(`(async () => { const P = window.__xpPix; P.box.appendChild(P.t); P.undo = await ${fig}.exploded.pose(${s}); return { ...${rect("P.t")}, settled: P.undo.settled }; })()`);
      const live = await shoot(liveBox, `${states[s]}-live`);
      const layerBox = await evaluate(`(async () => { const P = window.__xpPix; await P.undo(); P.spec.insertBefore(P.t, P.cover); P.comp = ${fig}.exploded.composite(${s}); P.box.appendChild(P.comp); return ${rect("P.comp.querySelector('[data-xp-id]')")}; })()`);
      const layers = await shoot(layerBox, `${states[s]}-layers`);
      await evaluate(`window.__xpPix.comp.remove()`);
      if (Math.abs(layerBox.width - liveBox.width) > 1 || Math.abs(layerBox.height - liveBox.height) > 1) {
        results.push({ state: states[s], ok: false, ratio: 1, text: `${states[s]}: layers are ${Math.round(layerBox.width)}×${Math.round(layerBox.height)}, live is ${Math.round(liveBox.width)}×${Math.round(liveBox.height)}` });
        continue;
      }
      const { ratio, bad } = await diff(live, layers);
      const ok = ratio <= 0.005 || bad <= 200;
      // A difference a moving or 3D component can't avoid is a warning, not a failure.
      const why = ok ? "" : !liveBox.settled || !captured[s] ? "it never settled" : is3d ? "3D: sheets can't restack its depth" : "";
      results.push({ state: states[s], ok: ok || !!why, warn: why, ratio, text: `${states[s]} ${(ratio * 100).toFixed(2)}% (${bad} px)${why ? `, ${why}` : ""}` });
    }
  } finally {
    await evaluate(`(() => { const P = window.__xpPix; P.spec.insertBefore(P.t, P.spec.firstChild); P.cover.remove(); delete window.__xpPix; for (const v of document.querySelectorAll('.xp-viewport')) v.style.visibility = ''; })()`);
  }
  const failing = results.filter((r) => !r.ok), warned = results.filter((r) => r.warn);
  const worst = results.filter((r) => !r.warn).sort((a, b) => b.ratio - a.ratio)[0];
  if (failing.length) return { ok: false, note: `${failing.map((r) => r.text).join(", ")} differ from the live component` };
  const head = `${results.length} state${results.length > 1 ? "s" : ""}${worst ? `, worst ${worst.text}` : ""}`;
  return { ok: true, note: head + (warned.length ? ` · ⚠ ${warned.map((r) => r.text).join("; ")}` : "") };
}

function cleanup(code) {
  if (closing) return;
  closing = true;
  // Wait for the browser to exit, so the next run can open the same profile.
  const done = () => { try { if (!aside) rmSync(profile, { recursive: true, force: true }); } catch (_) { /* */ } process.exit(code); };
  // Ask the browser to quit first: it then takes its helper processes with it.
  try { ws.send(JSON.stringify({ id: ++seq, method: "Browser.close" })); } catch (_) { /* not connected */ }
  setTimeout(() => { try { ws.close(); } catch (_) { /* */ } }, 500);
  proc.once("exit", done);
  setTimeout(() => stop("SIGTERM"), 1000);
  setTimeout(() => { stop("SIGKILL"); setTimeout(done, 300); }, 3000);
}
