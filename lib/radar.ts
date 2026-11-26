// The radar's model. One sealed snapshot in, one ranked board out.
//
// What the board ranks: protocols whose token does not exist yet. A protocol is pre-token when its
// snapshot record carries no market cap, no CoinGecko id and no symbol. Protocols whose token already
// trades are kept out of the ranking and shown apart, so a reader never mistakes a live token for an
// opportunity that has not launched.
//
// Where the implied value comes from: only the snapshot's own figures, and every protocol goes through
// the same arithmetic. No slug is ever special-cased.
//
//   base       = tvl_usd * BASE_MULTIPLE                       what the market pays per dollar of TVL
//   growth     = clamp(change_7d, -60, 120) percent            a week of momentum, clamped so one bad print
//                                                              cannot zero a launch and one pump cannot crown it
//   growthMult = 1 + (growth / 100) * GROWTH_WEIGHT             momentum counts at half weight
//   maturity   = 0.6 + clamp(age_days, 0, 1095) / 1095 * 0.4    a protocol that has run longer without a
//                                                              token has had longer to prove it survives
//   implied    = max(1, round(base * growthMult * maturity))
//
// The three inputs are the only ones the snapshot offers that speak to a launch: how much capital is
// already committed (TVL), whether it is growing (change_7d), and whether it persists (age).

/** One protocol exactly as the sealed snapshot carries it: ten fields, nothing inferred. */
export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

/** The model's constants: named, exported, so the page and the judge quote the same numbers. */
export interface Model {
  base_multiple: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
}

export const MODEL: Model = {
  base_multiple: 0.25,
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
};

export const MODEL_NAME = 'radar-2';

/** How many protocols below the watchlist floor the early tail adds, taken by TVL. */
const EARLY_TARGET = 180;
/** How many live-token protocols the separate live view carries, by market cap. */
const LIVE_TARGET = 24;
/** The gate's floor on a board: a board of fewer rows than this is refused. */
const MIN_ROWS = 100;

/** Something about the snapshot that makes it unusable. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** The snapshot out of a file's text, refused unless it is the shape this model reads. */
export function readSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotError('snapshot.json is not a JSON object');
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) {
    throw new SnapshotError('snapshot.json has no as_of date');
  }
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    }
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
    const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);
    return {
      slug: p.slug,
      name: p.name,
      category: str(p.category),
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: num(p.change_7d),
      mcap_usd: num(p.mcap_usd),
      listed_at: str(p.listed_at),
      gecko_id: str(p.gecko_id),
      symbol: str(p.symbol),
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** A protocol has no token yet: no market cap, no CoinGecko id, no symbol, all three absent. */
function noToken(p: Protocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

// A name ending in a release marker is a pool of another protocol, not a launch candidate:
// "Uniswap V3", "Aave v2", "Curve 3pool 2.0" are versions, not protocols.
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol can stand as a row: pre-token, not an exchange, not a versioned pool. */
function rankable(p: Protocol): boolean {
  return noToken(p) && p.category !== 'CEX' && !VERSION_SUFFIX.test(p.name);
}

/** Whole days between the snapshot's date and a listing date, or null when the date is absent or bad. */
export function ageInDays(listed_at: string | null, as_of: string): number | null {
  if (listed_at === null) return null;
  const listed = Date.parse(`${listed_at}T00:00:00Z`);
  const today = Date.parse(`${as_of}T00:00:00Z`);
  if (!Number.isFinite(listed) || !Number.isFinite(today)) return null;
  const days = Math.round((today - listed) / 86_400_000);
  return days < 0 ? 0 : days;
}

/** The three multipliers a row's implied value is built from, and the value itself. */
export interface Valuation {
  implied: number;
  growth_pct: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  age_days: number | null;
}

/** The implied value of one protocol, from its own TVL, its own week and its own age. */
export function valueOf(p: Protocol, as_of: string, model: Model = MODEL): Valuation {
  const age = ageInDays(p.listed_at, as_of);
  // A protocol with no week recorded is treated as flat: absent momentum is zero momentum, not a guess.
  const raw = p.change_7d === null ? 0 : p.change_7d;
  const growth = Math.min(model.growth_cap, Math.max(model.growth_floor, raw));
  const growthMult = 1 + (growth / 100) * model.growth_weight;
  const ageForModel = age === null ? model.unknown_age_days : age;
  const capped = Math.min(Math.max(ageForModel, 0), model.maturity_days);
  const maturityMult = model.maturity_floor + (capped / model.maturity_days) * model.maturity_range;
  const implied = Math.max(1, Math.round(p.tvl_usd * model.base_multiple * growthMult * maturityMult));
  return {
    implied,
    growth_pct: round4(growth),
    growth_multiplier: round4(growthMult),
    maturity_multiplier: round4(maturityMult),
    age_days: age,
  };
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** One row of the ranked board. */
export interface Row {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  listed_at: string | null;
  token_status: 'pre-token';
  implied_value_usd: number;
  value_per_tvl: number;
  model: {
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
  };
  farm_steps: string[];
}

/** How much a farmer needs for one position, from the protocol's own TVL: bigger protocols need more. */
function capitalFor(p: Protocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  if (p.tvl_usd >= 10_000_000) return 75;
  return 50;
}

/** How long a position must stay open, from the protocol's age: younger protocols need longer. */
function holdFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 90) return 90;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The chain a farmer actually starts on: the first listed, or a neutral phrase. */
function chainOf(p: Protocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** What one qualifying action is, in the words of the protocol's own category. */
function actionFor(p: Protocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Supply $${capital} of USDC to ${n} on ${chain} and keep the position open.`;
  }
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm') || c.includes('amm')) {
    return `Provide $${capital} of liquidity to ${n}'s deepest pool on ${chain} and keep the position open.`;
  }
  if (c.includes('bridge')) {
    return `Bridge $${capital} of USDC into ${chain} through ${n} and use the funds inside its own app.`;
  }
  if (c.includes('staking') || c.includes('restak')) {
    return `Stake $${capital} of ${chain}'s staking asset through ${n} and keep the receipt token.`;
  }
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) {
    return `Deposit $${capital} of USDC as margin on ${n} and open one small hedge so the account shows volume.`;
  }
  if (c.includes('prediction')) {
    return `Fund $${capital} and place one market position on ${n}.`;
  }
  if (c.includes('curator') || c.includes('allocator') || c.includes('vault')) {
    return `Deposit $${capital} into a ${n} vault on ${chain} and keep the shares.`;
  }
  if (c.includes('stable')) {
    return `Mint or deposit $${capital} of the stable asset through ${n} on ${chain}.`;
  }
  if (c.includes('rwa') || c.includes('real world')) {
    return `Mint $${capital} of the protocol's yield asset through ${n} on ${chain} and hold it.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${capital} of cover from ${n} on ${chain} and keep the policy open.`;
  }
  if (c.includes('liquid stak') || c.includes('lst')) {
    return `Stake $${capital} through ${n} on ${chain} and hold the liquid receipt.`;
  }
  return `Deposit $${capital} of USDC into ${n} on ${chain} and keep the position open.`;
}

/** The gas a first transaction costs on the chains the snapshot names. */
function gasFor(chain: string): number {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 12;
  if (c === 'solana') return 1;
  if (c.startsWith('base') || c.startsWith('arbitrum') || c.startsWith('optimism')) return 2;
  return 3;
}

/**
 * A protocol's farm plan: six steps, each an action with a dollar cost and a duration. The plan is
 * derived from the protocol's own record, so two protocols with the same category, chain and size get
 * the same advice and no protocol gets advice written by hand for it.
 */
export function farmPlan(p: Protocol, age: number | null): string[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdFor(age);
  const gas = gasFor(chain);
  const weekly = Math.max(1, Math.round(gas / 3));
  return [
    `Create a fresh wallet for this position alone and write its recovery phrase on paper kept offline; never reuse a wallet you have used elsewhere. Cost: ${gas === 1 ? 'under $1' : `about $${gas}`} of gas to fund it and move the first dollars. Time: 10 minutes.`,
    actionFor(p, capital, chain) + ` Cost: $${capital} of capital plus about $${gas} of gas. Time: 15 minutes once the wallet holds funds.`,
    `Repeat one qualifying action every week for the whole holding window: the same deposit, a small borrow, a swap or a governance vote, whichever ${p.name} counts as activity. Cost: about $${weekly} of gas a week. Time: 10 minutes a week.`,
    `Keep the position open for at least ${hold} days so that activity lands in more than one of the protocol's snapshots${age !== null ? `, and note that ${p.name} has run ${age} days without a token so its qualifying window is measured against that record` : ', and check how long it has run without a token before you count on a season'}. Cost: the $${capital} stays locked in the position. Time: ${hold} days.`,
    `Before withdrawing anything, open ${p.name}'s own site and its official announcements from the links it publishes, and claim rewards only from there; never approve a token you did not request and never pay to claim. Cost: nothing to check, and no legitimate claim charges a fee. Time: 10 minutes to verify each link.`,
    `Write every step into a farm log with the wallet address, the dates of each action, the amounts and the transaction hashes, so the position can be repeated or unwound without guessing. Cost: nothing but the record. Time: 5 minutes a week.`,
  ];
}

/** The ranked board: every watchlist slug, then the early tail below the floor, strongest first. */
export function buildBoard(snapshot: Snapshot, model: Model = MODEL): Row[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p] as const));
  const chosen = new Map<string, Protocol>();

  // The watchlist is the floor, never the ceiling: every slug on it is on the board even when the
  // snapshot has grown past it.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }

  // The early tail: the pre-token protocols below the watchlist floor, biggest first, so the board
  // still finds launches the watchlist does not name.
  const belowFloor = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && rankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const p of belowFloor.slice(0, EARLY_TARGET)) chosen.set(p.slug, p);

  // A snapshot thinner than the gate's row floor: keep adding pre-token protocols above the floor,
  // still by TVL, so the board is never refused for being short.
  if (chosen.size < MIN_ROWS) {
    const rest = snapshot.protocols
      .filter((p) => !chosen.has(p.slug) && rankable(p))
      .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
    for (const p of rest) {
      if (chosen.size >= MIN_ROWS) break;
      chosen.set(p.slug, p);
    }
  }

  const scored = [...chosen.values()].map((p) => ({ p, v: valueOf(p, snapshot.as_of, model) }));
  scored.sort((a, b) => b.v.implied - a.v.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  return scored.map(({ p, v }, i) => ({
    rank: i + 1,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    age_days: v.age_days,
    listed_at: p.listed_at,
    token_status: 'pre-token' as const,
    implied_value_usd: v.implied,
    value_per_tvl: p.tvl_usd > 0 ? round4(v.implied / p.tvl_usd) : 0,
    model: {
      base_multiple: model.base_multiple,
      growth_pct: v.growth_pct,
      growth_multiplier: v.growth_multiplier,
      maturity_multiplier: v.maturity_multiplier,
    },
    farm_steps: farmPlan(p, v.age_days),
  }));
}

/**
 * Why a board would be refused by the gate, or null when it stands. Every refusal names the first row
 * that breaks it, so a boarding error is one line, not a search.
 */
export function gateIssue(board: Row[], snapshot: Snapshot): string | null {
  const slugSet = new Set(snapshot.protocols.map((p) => p.slug));
  const present = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !present.has(s));
  if (missing.length > 0) {
    return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  }
  if (board.length < MIN_ROWS) return `the board holds ${board.length} rows, under the gate's ${MIN_ROWS}`;
  const seen = new Set<string>();
  for (const r of board) {
    if (seen.has(r.slug)) return `${r.slug} appears twice`;
    seen.add(r.slug);
    if (!slugSet.has(r.slug)) return `${r.slug} is not a protocol the snapshot lists`;
    if (r.name.trim() === '') return `${r.slug} has no name`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) {
      return `row ${i + 1} outranks row ${i} on implied value`;
    }
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the implied value $${board[0]!.implied_value_usd}`;
  }
  return null;
}

/** A live-token protocol, shown apart from the ranking. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  tvl_to_mcap: number | null;
}

/** The protocols whose token already trades, by market cap: the market's own numbers, never scored. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !noToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_TARGET)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      tvl_to_mcap: p.mcap_usd !== null && p.mcap_usd > 0 ? round4(p.tvl_usd / p.mcap_usd) : null,
    }));
}

/** One row as the page gets it: the ranking's own fields, nothing recomputed in the browser. */
export interface PageRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  on_watchlist: boolean;
  implied_value_usd: number;
  value_per_tvl: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  plan: string[];
}

/** Everything the page renders, written to data.js as one object. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: Model;
  model_name: string;
  counts: {
    protocols: number;
    watchlist: number;
    board: number;
    below_floor: number;
    live: number;
    categories: number;
  };
  totals: {
    implied_usd: number;
    tvl_usd: number;
    median_implied_usd: number;
    widest_growth_pct: number;
  };
  rows: PageRow[];
  live: LiveRow[];
}

/** The page's dataset, from the board that was just written. */
export function buildRadar(snapshot: Snapshot, board: Row[]): RadarData {
  const watch = new Set(snapshot.watchlist);
  const implied = board.map((r) => r.implied_value_usd).sort((a, b) => a - b);
  const mid = implied.length === 0 ? 0 : implied[Math.floor(implied.length / 2)]!;
  const growths = board.map((r) => r.model.growth_pct);
  return {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: MODEL,
    model_name: MODEL_NAME,
    counts: {
      protocols: snapshot.protocols.length,
      watchlist: snapshot.watchlist.length,
      board: board.length,
      below_floor: board.filter((r) => !watch.has(r.slug)).length,
      live: snapshot.protocols.filter((p) => !noToken(p)).length,
      categories: new Set(board.map((r) => r.category ?? 'Unknown')).size,
    },
    totals: {
      implied_usd: board.reduce((n, r) => n + r.implied_value_usd, 0),
      tvl_usd: board.reduce((n, r) => n + r.tvl_usd, 0),
      median_implied_usd: mid,
      widest_growth_pct: growths.length === 0 ? 0 : Math.round(Math.max(...growths)),
    },
    rows: board.map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      age_days: r.age_days,
      on_watchlist: watch.has(r.slug),
      implied_value_usd: r.implied_value_usd,
      value_per_tvl: r.value_per_tvl,
      growth_multiplier: r.model.growth_multiplier,
      maturity_multiplier: r.model.maturity_multiplier,
      plan: r.farm_steps,
    })),
    live: liveRows(snapshot),
  };
}