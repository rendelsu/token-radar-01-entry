// Token Radar model (round 2): comparable-launch valuation.
//
// The implied value of a pre-token protocol is built only from the
// snapshot's own figures, never from a hardcoded list of names:
//   implied = TVL x category multiple x growth factor x age factor
//
// Category multiple: the median mcap/TVL of the live tokens in the
// same category, winsorized to [0.005, 5] so one outlier cannot set
// the price, then shrunk toward the snapshot-wide median with a prior
// weight of 3 live tokens, so a category with one thin comparable
// (Risk Curators: Api3 at 2.97x) lands between its comp and the
// field, and a category with no live token at all falls back to the
// field median. The multiple is clamped to [0.05, 3.00].
//
// Growth factor: 1 + clamp(change_7d, -25%, +25%), with change_7d in
// percent units as the snapshot carries it; a missing reading is 1.
// Age factor: 0.85 + 0.15 x min(age in years, 5) / 5, so a protocol
// that has run longer with no token and kept its TVL counts for a
// little more, never for much more.
//
// A protocol is a launch candidate when the snapshot records no token
// for it at all (no symbol, no market cap, no CoinGecko id), it is
// not a wrapped, staked, bridged, restaked or exchange product, its
// name is not a versioned redeploy (V1/V2/...), and it holds at least
// $5M of TVL. The watchlist is the floor: every watchlist protocol
// is on the board, and the early radar adds the rest below it.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  category: string;
  chains: string[];
  chain_count: number;
  tvl_usd: number;
  change_7d: number | null;
  age_years: number;
  multiple: number;
  comps_n: number;
  cat_median: number;
  growth_factor: number;
  age_factor: number;
  base_value: number;
  implied_value_usd: number;
  implied_low: number;
  implied_high: number;
  farm_steps: string[];
  watchlist: boolean;
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string;
  tvl_usd: number;
  mcap_usd: number;
  ratio: number;
}

export interface Board {
  rows: BoardRow[];
  live: LiveRow[];
  as_of: string;
  total_implied: number;
  median_multiple: number;
  global_median: number;
  live_n: number;
}

const PRIOR_WEIGHT = 3;
const MULT_MIN = 0.05;
const MULT_MAX = 3.0;
const RATIO_LO = 0.005;
const RATIO_HI = 5.0;
const EARLY_MIN_TVL = 5_000_000;

// Categories whose products are not launch candidates: exchanges,
// bridges, wrapped and staked products. Their tokens either trade
// already or the product is a wrapper, not a protocol awaiting a
// first token.
const BLOCKED_CATEGORIES = new Set([
  "CEX",
  "Bridge",
  "Canonical Bridge",
  "Liquid Staking",
  "Liquid Restaking",
  "Restaked BTC",
]);

const VERSIONED_NAME = /\bV\d+\s*$/;
const STAKING_NAME = /stak|restak|lsts?/i;

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function ageYears(listedAt: string, asOf: string): number {
  const start = Date.parse(listedAt + "T00:00:00Z");
  const end = Date.parse(asOf + "T00:00:00Z");
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return 1;
  return (end - start) / (365.25 * 24 * 60 * 60 * 1000);
}

function hasToken(p: SnapshotProtocol): boolean {
  return p.symbol !== null || p.mcap_usd !== null || p.gecko_id !== null;
}

function isCandidate(p: SnapshotProtocol): boolean {
  if (hasToken(p)) return false;
  if (BLOCKED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED_NAME.test(p.name)) return false;
  if (STAKING_NAME.test(p.name)) return false;
  return p.tvl_usd >= EARLY_MIN_TVL;
}

export function growthFactor(change7d: number | null): number {
  if (change7d === null || Number.isNaN(change7d)) return 1;
  // change_7d arrives in percent units (-2.19 means -2.19%).
  return 1 + clamp(change7d / 100, -0.25, 0.25);
}

export function ageFactor(age: number): number {
  return 0.85 + 0.15 * (Math.min(age, 5) / 5);
}

// ---- farm plans -------------------------------------------------------
// Every step is concrete: it names the protocol, a chain it actually
// runs on, an amount, a cost and a time. The action verb, venue and
// cadence come from the protocol's own category, so a vault curator
// gets a vault plan and a prediction market gets a trading plan.
// Amounts scale with the protocol's TVL tier; gas scales with whether
// the chain is Ethereum (expensive) or a cheaper chain.

interface CategoryPlay {
  action: string;
  venue: string;
  asset: string;
  recurring: string;
  exit: string;
}

const PLAYS: Record<string, CategoryPlay> = {
  "Risk Curators": {
    action: "Deposit into a vault",
    venue: "vault",
    asset: "USDC",
    recurring: "top up the vault after a rebalance and check the curator's allocation note",
    exit: "withdraw the vault shares back to the wallet",
  },
  "Onchain Capital Allocator": {
    action: "Deposit into an allocation vault",
    venue: "vault",
    asset: "USDC",
    recurring: "review the allocator's new positions and add to the best one",
    exit: "withdraw the vault shares back to the wallet",
  },
  "Prediction Market": {
    action: "Place a position on a market",
    venue: "market",
    asset: "USDC",
    recurring: "settle one market and open a position on a fresh one",
    exit: "close the open positions and withdraw the balance",
  },
  "CDP": {
    action: "Open a vault and mint the stablecoin against collateral",
    venue: "vault",
    asset: "ETH",
    recurring: "check the collateral ratio and top it up before it nears liquidation",
    exit: "repay the minted stablecoin and unlock the collateral",
  },
  "Dexs": {
    action: "Add liquidity to a pool",
    venue: "pool",
    asset: "ETH and USDC",
    recurring: "collect the pool fees and rebalance the range if the price moved out of it",
    exit: "remove the liquidity and keep the fee earnings",
  },
  "Lending": {
    action: "Supply assets to the lending pool",
    venue: "pool",
    asset: "USDC",
    recurring: "claim the supply rewards and check the borrow rate before borrowing",
    exit: "withdraw the supplied assets and any unclaimed rewards",
  },
  "Yield": {
    action: "Deposit into a yield strategy",
    venue: "strategy",
    asset: "USDC",
    recurring: "harvest the yield and compound it back into the same strategy",
    exit: "withdraw the deposit and the harvested yield",
  },
  "Yield Aggregator": {
    action: "Deposit into the aggregator vault",
    venue: "vault",
    asset: "USDC",
    recurring: "compare the vault's yield with the underlying strategies and stay in the best one",
    exit: "withdraw from the vault back to the wallet",
  },
  "Basis Trading": {
    action: "Mint the basis position",
    venue: "position",
    asset: "ETH",
    recurring: "check the funding rate and the peg, and hold while the basis pays",
    exit: "redeem the position back to the underlying asset",
  },
  "RWA": {
    action: "Buy a tokenized real-world position",
    venue: "offering",
    asset: "USDC",
    recurring: "check the issuer's attestation and the next payout date",
    exit: "redeem the position through the issuer's redemption flow",
  },
  "Derivatives": {
    action: "Open a hedged derivatives position",
    venue: "market",
    asset: "USDC",
    recurring: "check the margin and the funding rate, and trim the position if either spikes",
    exit: "close the position and withdraw the margin",
  },
  "Liquid Staking": {
    action: "Stake and hold the liquid staking token",
    venue: "staking pool",
    asset: "ETH",
    recurring: "restake the staking rewards and keep the receipt token in the wallet",
    exit: "unstake and wait out the unbonding period",
  },
  "Restaking": {
    action: "Restake the receipt token with an operator",
    venue: "operator",
    asset: "ETH",
    recurring: "check the operator's uptime and slashing record, and switch operator if it slips",
    exit: "withdraw from the operator and unstake",
  },
  "Chain": {
    action: "Bridge funds in and use the chain's flagship app",
    venue: "app",
    asset: "USDC",
    recurring: "use one more native app each week so the wallet touches more of the chain",
    exit: "bridge the funds back out to the home chain",
  },
  "Farm": {
    action: "Deposit into the farm",
    venue: "farm",
    asset: "USDC",
    recurring: "harvest the farm rewards and stake them again while the rate holds",
    exit: "withdraw the deposit and the harvested rewards",
  },
};

const DEFAULT_PLAY: CategoryPlay = {
  action: "Use the protocol on its home chain",
  venue: "app",
  asset: "USDC",
  recurring: "make one qualifying on-chain action each week",
  exit: "unwind the position through the protocol's own interface",
};

function tier(amount: number): { big: number; small: number } {
  if (amount >= 1_000_000_000) return { big: 200, small: 100 };
  if (amount >= 100_000_000) return { big: 120, small: 60 };
  return { big: 60, small: 30 };
}

function gasFor(chains: string[]): string {
  return chains.includes("Ethereum") ? "about $8 of gas" : "about $2 of gas";
}

function farmSteps(p: SnapshotProtocol): string[] {
  const play = PLAYS[p.category] ?? DEFAULT_PLAY;
  const chain1 = p.chains[0] ?? "Ethereum";
  const chain2 = p.chains[1] ?? chain1;
  const { big, small } = tier(p.tvl_usd);
  const gas = gasFor(p.chains);
  const name = p.name;
  return [
    `Use a fresh wallet that holds only the funds you plan to farm with ${name}, and keep its seed phrase offline on paper. Cost: under $3 of gas for the first transaction on ${chain1}. Time: 5 minutes.`,
    `${play.action} with $${big} of ${play.asset} in the ${name} ${play.venue} on ${chain1} and keep the receipt in the same wallet. Cost: $${big} of capital and ${gas}. Time: 15 minutes to set up.`,
    `Repeat a smaller position of about $${small} on ${chain2} so the activity is visible on more than one chain. Cost: about $${small} of capital and ${gas}. Time: 15 minutes.`,
    `Once a week, ${play.recurring}. Cost: about $2 of gas a week. Time: 10 minutes a week.`,
    `Hold the position for at least 30 days so the activity is counted in more than one snapshot. Cost: the $${big} stays in the position. Time: 30 days.`,
    `Before you withdraw, open ${name}'s own points or rewards page and claim only from the link it publishes. Cost: no fee to check, and never pay to claim. Time: 10 minutes.`,
    `Never connect the farm wallet to a link from a direct message, and never pay anyone to claim or to speed up a reward from ${name}. Cost: nothing, and it saves the whole position. Time: 1 minute to check the domain.`,
    `Write the wallet, the dates and every transaction in a farm log, then ${play.exit} when you are done. Cost: nothing but the log. Time: 5 minutes to write, 15 minutes to unwind.`,
  ];
}

// ---- board ------------------------------------------------------------

export function buildBoard(snapshot: Snapshot): Board {
  const live = snapshot.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
  const liveRatios = live.map((p) =>
    clamp(p.mcap_usd! / p.tvl_usd, RATIO_LO, RATIO_HI),
  );
  const globalMedian = median(liveRatios);

  const byCategory = new Map<string, number[]>();
  for (const p of live) {
    const ratio = clamp(p.mcap_usd! / p.tvl_usd, RATIO_LO, RATIO_HI);
    const list = byCategory.get(p.category) ?? [];
    list.push(ratio);
    byCategory.set(p.category, list);
  }

  const multipleFor = (category: string): { multiple: number; n: number; catMedian: number } => {
    const comps = byCategory.get(category) ?? [];
    const catMedian = comps.length > 0 ? median(comps) : globalMedian;
    const multiple = clamp(
      (comps.length * catMedian + PRIOR_WEIGHT * globalMedian) /
        (comps.length + PRIOR_WEIGHT),
      MULT_MIN,
      MULT_MAX,
    );
    return { multiple, n: comps.length, catMedian };
  };

  const watchlist = new Set(snapshot.watchlist);
  const candidates = snapshot.protocols.filter(
    (p) => watchlist.has(p.slug) || isCandidate(p),
  );

  const scored = candidates.map((p) => {
    const { multiple, n, catMedian } = multipleFor(p.category);
    const growth = growthFactor(p.change_7d);
    const age = ageYears(p.listed_at, snapshot.as_of);
    const ageF = ageFactor(age);
    const base = p.tvl_usd * multiple;
    const implied = Math.round(base * growth * ageF);
    return {
      p,
      multiple,
      n,
      catMedian,
      growth,
      age,
      ageF,
      base: Math.round(base),
      implied,
      low: Math.round(p.tvl_usd * multiple * 0.8 * growth * ageF),
      high: Math.round(p.tvl_usd * multiple * 1.2 * growth * ageF),
    };
  });

  scored.sort((a, b) => {
    if (b.implied !== a.implied) return b.implied - a.implied;
    return a.p.slug < b.p.slug ? -1 : 1;
  });

  const rows: BoardRow[] = scored.map((s, i) => ({
    slug: s.p.slug,
    name: s.p.name,
    rank: i + 1,
    category: s.p.category,
    chains: s.p.chains,
    chain_count: s.p.chains.length,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    age_years: Math.round(s.age * 100) / 100,
    multiple: Math.round(s.multiple * 1000) / 1000,
    comps_n: s.n,
    cat_median: Math.round(s.catMedian * 1000) / 1000,
    growth_factor: Math.round(s.growth * 1000) / 1000,
    age_factor: Math.round(s.ageF * 1000) / 1000,
    base_value: s.base,
    implied_value_usd: s.implied,
    implied_low: s.low,
    implied_high: s.high,
    farm_steps: farmSteps(s.p),
    watchlist: watchlist.has(s.p.slug),
  }));

  const liveRows: LiveRow[] = live
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      ratio: Math.round(clamp(p.mcap_usd! / p.tvl_usd, RATIO_LO, RATIO_HI) * 1000) / 1000,
    }))
    .sort((a, b) => b.mcap_usd - a.mcap_usd);

  const totalImplied = rows.reduce((sum, r) => sum + r.implied_value_usd, 0);
  return {
    rows,
    live: liveRows,
    as_of: snapshot.as_of,
    total_implied: totalImplied,
    median_multiple: median(rows.map((r) => r.multiple)),
    global_median: globalMedian,
    live_n: live.length,
  };
}
