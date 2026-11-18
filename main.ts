// Token Radar entry point (round 3).
//
// Reads the snapshot, builds the board with lib/model.ts, and writes
// the graded outputs:
//   board.json    the ranked board (rows + farm plans)
//   data.js       window.RADAR = {...} for the dashboard page
//   dashboard/    the page itself (copied)
//   screenshots/  the three screenshots (copied)
//   dossier.json  what buildDossier writes from dashboard/ + screenshots/
//
// Run:  MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
// Defaults: input /input/snapshot.json, output $MAKEFUN_OUTPUT_DIR
// or /output. Node 22 standard library only; no network, no clock,
// no randomness, so two runs write the same bytes.

import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBoard, type Board, type Snapshot } from "./lib/model.ts";
import { buildDossier } from "./vendor/makefun-board.ts";

const repoRoot = dirname(fileURLToPath(import.meta.url));

function flagValue(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index === -1 || index + 1 >= argv.length) return null;
  return argv[index + 1];
}

function main(): void {
  const argv = process.argv.slice(2);
  const inputPath = flagValue(argv, "--input") ?? "/input/snapshot.json";
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

  const snapshot: Snapshot = JSON.parse(
    readFileSync(inputPath, "utf8"),
  );
  const board: Board = buildBoard(snapshot);

  // Fail fast on a snapshot the model cannot score: an empty board or
  // a watchlist protocol missing from it means the input changed shape
  // and the graded outputs would be silently wrong.
  if (board.rows.length === 0) {
    throw new Error("token-radar: board is empty, refusing to write outputs");
  }
  const missingWatchlist = snapshot.watchlist.filter(
    (slug) => !board.rows.some((r) => r.slug === slug),
  );
  if (missingWatchlist.length > 0) {
    throw new Error(
      `token-radar: ${missingWatchlist.length} watchlist protocols missing from the board`,
    );
  }

  mkdirSync(outDir, { recursive: true });

  const boardJson = { rows: board.rows };
  writeFileSync(join(outDir, "board.json"), JSON.stringify(boardJson));

  const radar = {
    as_of: board.as_of,
    total_implied: board.total_implied,
    median_multiple: board.median_multiple,
    global_median: board.global_median,
    live_n: board.live_n,
    accounting: board.accounting,
    rows: board.rows,
    live: board.live,
  };
  writeFileSync(join(outDir, "data.js"), `window.RADAR=${JSON.stringify(radar)};\n`);

  cpSync(join(repoRoot, "dashboard"), join(outDir, "dashboard"), { recursive: true });
  cpSync(join(repoRoot, "screenshots"), join(outDir, "screenshots"), { recursive: true });

  const dossier = buildDossier(outDir, { text_max_bytes: 65_536 });
  writeFileSync(join(outDir, "dossier.json"), dossier);

  const top = board.rows[0];
  console.log(
    `board: ${board.rows.length} rows, ${board.live_n} live comparables ` +
      `(global median ${board.global_median.toFixed(3)}x), ` +
      `total implied $${board.total_implied.toLocaleString("en-US")}, ` +
      `top #1 ${top.name} $${top.implied_value_usd.toLocaleString("en-US")}`,
  );
}

main();
