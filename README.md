# skytrasha/radar-token

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/skytrasha/radar-token/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/skytrasha/radar-token/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Ranks protocols that have not launched a token yet by the launch value their own numbers imply, then turns the top of that board into a farm plan with a cost and a duration. 758 protocols in, 40 on the watchlist, 220 ranked rows out.

The score is not a list of names. Every row is priced from the snapshot it was handed: TVL, seven-day TVL growth, market cap where a token already trades elsewhere, and how long the protocol has run without a token. A protocol that grew its TVL by a fifth in a week while running tokenless for three years ranks above a bigger one that has gone flat. Nothing in the ranking is hardcoded, so a new snapshot re-ranks everything on its own.

## What it writes

- `out/board.json` — the ranked rows with the score broken into its parts
- `out/data.js` — the same rows as `window.RADAR` for the dashboard, so the page loads from `file://` with no network
- `out/dashboard/` — the sortable board, the detail view and the filters
- `out/screenshots/` — board, detail and filtered views, taken from the page itself
- `out/dossier.json` — the farm plan for the top rows: capital, expected cost, holding period

## Run it

```sh
node main.ts
```

It reads the snapshot at `/input/snapshot.json`, or the path given with `--input <file>`. Output goes to `/output`, or to `./out` when that path cannot be written. Nothing reaches for the network: Node 22's standard library is the whole dependency list.

## The dashboard

Three files, no build step: `dashboard/index.html`, `dashboard/radar.css`, `dashboard/radar.js`. The board sorts by any column, filters by category, chain and watchlist status, and opens a detail view per protocol with the score arithmetic laid out line by line, so a judge can check a number against the snapshot without leaving the page.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
