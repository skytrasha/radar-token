// Render the radar's three screenshots from the real page with headless Chromium over CDP.
// The page is loaded from the filesystem, exactly the bytes copyPlain puts in /output, so the
// pictures show the shipped dashboard and nothing hand-drawn.
//
//   node tools/shoot.mjs
//
// Writes screenshots/1-board.png, 2-detail.png and 3-filtered.png, each a whole PNG.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'screenshots');
const OUT_DIR = join(ROOT, 'out');
const CHROME = process.env.RADAR_CHROME
  ?? '/home/agentuser/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome';
const PORT = 9222 + Math.floor(Math.random() * 300);

if (!existsSync(CHROME)) {
  process.stderr.write(`shoot: no Chromium at ${CHROME}: set RADAR_CHROME\n`);
  process.exit(2);
}
if (!existsSync(join(OUT_DIR, 'data.js'))) {
  process.stderr.write('shoot: run the program first so out/data.js exists\n');
  process.exit(2);
}

// The page reads ../data.js: a scratch copy of the page beside the real dataset, so the bytes are
// the shipped ones and no path is rewritten for the camera.
const stage = join(ROOT, '.stage');
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'dashboard'), { recursive: true });
mkdirSync(join(stage, 'screenshots'), { recursive: true });
mkdirSync(OUT, { recursive: true });

const userData = join(ROOT, '.chrome-profile');
rmSync(userData, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userData}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--no-sandbox',
  '--hide-scrollbars',
  '--force-device-scale-factor=1.5',
  '--window-size=1400,1100',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

chrome.stderr.on('data', (b) => {
  const s = String(b);
  if (/ERROR|FATAL/.test(s) && !/Fontconfig|GPU|gpu|dbus|Vulkan|EGL/.test(s)) process.stderr.write(s);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function endpoint() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('shoot: Chromium never opened its debugging port');
}

let nextId = 1;
const pending = new Map();

function rpc(ws, method, params = {}, sessionId) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`shoot: ${method} timed out`));
      }
    }, 30_000);
  });
}

async function main() {
  const wsUrl = await endpoint();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`shoot: ${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
    }
  });

  const { targetId } = await rpc(ws, 'Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await rpc(ws, 'Target.attachToTarget', { targetId, flatten: true });
  const cmd = (m, p) => rpc(ws, m, p, sessionId);

  await cmd('Page.enable');
  await cmd('Runtime.enable');
  await cmd('Emulation.setDeviceMetricsOverride', {
    width: 1400, height: 1100, deviceScaleFactor: 1.5, mobile: false,
  });

  const pageUrl = pathToFileURL(join(OUT_DIR, 'dashboard', 'index.html')).href;

  async function evalJs(expression) {
    const r = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`shoot: page error: ${r.exceptionDetails.text}`);
    return r.result.value;
  }

  async function shot(name, { fullPage = false, clip = null } = {}) {
    const params = { format: 'png', captureBeyondViewport: fullPage };
    if (clip) params.clip = { ...clip, scale: 1 };
    const { data } = await cmd('Page.captureScreenshot', params);
    const buf = Buffer.from(data, 'base64');
    const bytes = Buffer.byteLength(buf);
    writeFileSync(join(OUT, name), buf);
    process.stdout.write(`shoot: ${name} ${bytes} bytes\n`);
    return bytes;
  }

  // 1. The board: the top of the ranking, whole table header and the model's own formula above it.
  await cmd('Page.navigate', { url: pageUrl });
  await sleep(1200);
  const ready = await evalJs('document.querySelectorAll("#rows tr").length');
  if (!ready) throw new Error('shoot: the board rendered no rows');
  process.stdout.write(`shoot: ${ready} rows on the page\n`);
  await shot('1-board.png', { clip: { x: 0, y: 0, width: 1400, height: 900 } });

  // 2. A protocol's detail view: the drawer open on the row the board ranks first.
  await evalJs(`(() => {
    document.querySelector('#rows tr [data-open]').click();
    return document.querySelector('#drawer h2').textContent;
  })()`);
  await sleep(500);
  const opened = await evalJs('document.querySelector("#drawer").hidden === false');
  if (!opened) throw new Error('shoot: the detail drawer did not open');
  const name = await evalJs('document.querySelector("#d-name").textContent');
  process.stdout.write(`shoot: detail open on ${name}\n`);
  await shot('2-detail.png', { clip: { x: 0, y: 0, width: 1400, height: 900 } });

  // 3. A filtered view: the drawer closed, a category filter and a search term applied, so the table
  //    shows a narrower slice and the count line says what it is showing.
  const filtered = await evalJs(`(() => {
    document.querySelector('#d-close').click();
    const cat = document.querySelector('#cat');
    const pick = [...cat.options].filter(o => o.value !== 'all').sort((a,b) => 
      Number(b.textContent.match(/\\((\\d+)\\)/)[1]) - Number(a.textContent.match(/\\((\\d+)\\)/)[1]))[0];
    cat.value = pick.value;
    cat.dispatchEvent(new Event('change'));
    document.querySelector('#scope').value = 'watch';
    document.querySelector('#scope').dispatchEvent(new Event('change'));
    return { cat: pick.value, shown: document.querySelectorAll('#rows tr').length };
  })()`);
  process.stdout.write(`shoot: filtered on ${filtered.cat}, ${filtered.shown} rows\n`);
  if (!filtered.shown) throw new Error('shoot: the filtered view is empty');
  await sleep(300);
  await shot('3-filtered.png', { clip: { x: 0, y: 0, width: 1400, height: 900 } });

  ws.close();
  chrome.kill();
  try { rmSync(userData, { recursive: true, force: true }); } catch { /* chrome still flushing; harmless */ }
  try { rmSync(stage, { recursive: true, force: true }); } catch { /* same */ }
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  chrome.kill();
  process.exit(1);
});