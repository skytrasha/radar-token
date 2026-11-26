// token-radar-01 entry: a pre-token radar that scores every protocol still without a token and tells
// a reader what it would cost, in dollars and in days, to farm each one.
//
// The program reads the sealed snapshot, builds the board (watchlist first, then the early tail below
// the floor), writes board.json, writes the dashboard's dataset as data.js beside the page, copies the
// page and the screenshots into /output, and writes dossier.json from what it just wrote.
//
// Node 22, standard library only, no network. Outside the grader:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBoard, buildRadar, gateIssue, readSnapshot } from './lib/radar.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

// The scorer's caps, read from reference/gate.json: the text cap shapes the dossier's bytes, the rest
// only refuse a hand-in that is already wrong.
const TEXT_CAP_BYTES = 65_536;
const SHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASH_CAPS = { max_files: 400, max_bytes: 4_194_304 };
const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function flag(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

const inputArg = flag('input', '/input');
const snapshotPath = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(snapshotPath)) {
  process.stderr.write(`radar: no snapshot at ${snapshotPath}\n`);
  process.exit(2);
}
const outDir = flag('output', process.env.MAKEFUN_OUTPUT_DIR ?? defaultOutputDir());

/** The grader mounts /output; everywhere else fall back to ./out so a run needs no writable root. */
function defaultOutputDir(): string {
  try {
    mkdirSync('/output', { recursive: true });
    return '/output';
  } catch {
    return join(process.cwd(), 'out');
  }
}

const snapshot = readSnapshot(readFileSync(snapshotPath, 'utf8'));
const board = buildBoard(snapshot);
const refusal = gateIssue(board, snapshot);
if (refusal !== null) {
  process.stderr.write(`radar: the board the model wrote would be refused: ${refusal}\n`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const radar = buildRadar(snapshot, board);
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outDir, 'data.js'), `window.RADAR=${JSON.stringify(radar)};\n`);

/** Copy one directory's plain files into `to`, skipping dot names; returns the names copied. */
function copyPlain(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const names: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    if (!PLAIN_NAME.test(name)) {
      process.stderr.write(`radar: ${name}: a delivered file is named with letters, digits and . _ -\n`);
      process.exit(1);
    }
    copyFileSync(path, join(to, name));
    names.push(name);
  }
  return names;
}

copyPlain(join(ROOT, 'dashboard'), join(outDir, 'dashboard'));
const shots = copyPlain(join(ROOT, 'screenshots'), join(outDir, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`radar: screenshots/ holds ${shots.length}: hand in the board, a detail view and a filtered view\n`);
  process.exit(1);
}

// Last, so the dossier describes exactly the /output that exists when the program exits.
writeFileSync(
  join(outDir, 'dossier.json'),
  buildDossier(outDir, { text_max_bytes: TEXT_CAP_BYTES, screenshots: SHOT_CAPS, dashboard: DASH_CAPS }),
);

process.stdout.write(
  `radar: ${snapshot.protocols.length} protocols read, ${snapshot.watchlist.length} on the watchlist, ` +
    `${board.length} rows ranked (${radar.counts.below_floor} below the floor, ${radar.counts.live} live protocols set aside)\n` +
    `radar: wrote board.json, data.js, dashboard/ (${readdirSync(join(ROOT, 'dashboard')).length} files), ` +
    `screenshots/ (${shots.length}) and dossier.json\n`,
);