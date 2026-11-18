// Token Radar model (round 3): comparable-launch valuation.
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
// little more, never for much more. Age is measured from the
// snapshot's listed_at field to the snapshot's as_of date; a protocol
// with no listing date in the snapshot defaults to 1 year, and the
// detail view flags that default as an assumption.
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
  listed_at: string;
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
  plan_summary: string;
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

// How every protocol in the snapshot is accounted for: ranked, a
// live-token comparable, or set aside with the first reason that
// excludes it (checked in this order, so the reasons are disjoint).
export interface Accounting {
  snapshot_n: number;
  ranked_n: number;
  live_n: number;
  set_aside_n: number;
  watchlist_n: number;
  watchlist_with_token: number;
  set_aside: {
    has_token: number;
    blocked_category: number;
    versioned_name: number;
    staking_name: number;
    below_floor: number;
    other: number;
  };
}

export interface Board {
  rows: BoardRow[];
  live: LiveRow[];
  as_of: string;
  total_implied: number;
  median_multiple: number;
  global_median: number;
  live_n: number;
  accounting: Accounting;
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
// Amounts scale with the protocol's TVL tier; network-fee estimates
// scale with whether the chain is Ethereum (expensive) or a cheaper
// chain, and are labeled estimates, never guaranteed costs.
//
// Timing is split into active time (minutes of the reader's own work)
// and elapsed time (how long a position is meant to stay open).
// Active times are labeled estimates of user effort, differentiated
// by how involved the category's main action is. Elapsed horizons
// are RECOMMENDATIONS, never protocol requirements: the snapshot
// states no holding period, lockup or eligibility rule for any
// protocol, so no step invents one. Where an exit can involve a
// protocol-stated delay (unbonding, withdrawal queues), the step
// says to check the protocol's current terms instead of asserting
// a duration.
//
// Capital and fees stay separate in every step: an amount of capital
// is the reader's own funds placed in a position, not a cost, and
// the fee estimates beside it are the cost of the transactions. The
// plan summary restates the split in one line.

interface CategoryPlay {
  action: string;
  venue: string;
  asset: string;
  recurring: string;
  exit: string;
  // Active minutes the main action takes to set up (labeled estimate).
  setupMinutes: number;
  // When the recurring action repeats, and how long it takes each time.
  cadence: string;
  cadenceMinutes: number;
  cadenceFreq: string;
  // The suggested horizon: a recommendation, never a requirement.
  horizonAction: string;
  horizonTime: string;
  horizonShort: string;
  // Optional override for the first step's wallet wording ({name} is
  // replaced with the protocol's name).
  wallet?: string;
  // Optional override for the second step's action sentence, for
  // protocols whose action does not fit the generic template
  // ({big} is the main amount, {chain1} the first chain).
  step2?: string;
}

const DEFAULT_PLAY: CategoryPlay = {
  action: "Use the protocol on its home chain",
  venue: "app",
  asset: "USDC",
  recurring: "make one qualifying on-chain action",
  exit: "unwind the position through the protocol's own interface",
  setupMinutes: 15,
  cadence: "Once a week",
  cadenceMinutes: 10,
  cadenceFreq: "a week",
  horizonAction:
    "Suggested horizon (a recommendation, not a protocol requirement): stay in through at least one full rewards cycle if the protocol publishes one; otherwise review the position monthly and exit when the reason you entered is gone.",
  horizonTime: "one rewards cycle, or monthly reviews (elapsed time, not active work)",
  horizonShort: "one rewards cycle, or monthly reviews",
};

// Per-category plays. Entries give only what differs from the
// default: the action, venue, asset, recurring action and exit come
// from what the category name means, and the timing fields only where
// the category's rhythm genuinely differs.
const PLAYS: Record<string, Partial<CategoryPlay>> = {
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
    recurring: "close out the settled market and open a position on a fresh one",
    exit: "close the open positions and withdraw the balance",
    cadence: "After each market settles",
    cadenceMinutes: 15,
    cadenceFreq: "per settlement",
    horizonAction:
      "Suggested horizon (a recommendation, not a protocol requirement): keep each position open until its market settles — the market's own end date sets the elapsed time, not a calendar.",
    horizonTime: "until your markets settle (elapsed time, not active work)",
    horizonShort: "until your markets settle",
  },
  "CDP": {
    action: "Open a vault and mint the stablecoin against collateral",
    venue: "vault",
    asset: "ETH",
    recurring: "check the collateral ratio and top it up before it nears liquidation",
    exit: "repay the minted stablecoin and unlock the collateral",
    setupMinutes: 25,
    horizonAction:
      "Suggested horizon (a recommendation, not a protocol requirement): keep the vault open while the collateral ratio stays comfortable, and review it after any large price move.",
    horizonTime: "open-ended, reviewed after large price moves (elapsed time, not active work)",
    horizonShort: "open-ended, reviewed after price moves",
  },
  "CDP Manager": {
    action: "Open a managed CDP position",
    venue: "vault",
    asset: "ETH",
    recurring: "check the collateral ratio and the manager's rebalancing, and top up before liquidation risk rises",
    exit: "repay the minted stablecoin and unlock the collateral",
    setupMinutes: 25,
    horizonAction:
      "Suggested horizon (a recommendation, not a protocol requirement): keep the position open while the collateral ratio stays comfortable, and review it after any large price move.",
    horizonTime: "open-ended, reviewed after large price moves (elapsed time, not active work)",
    horizonShort: "open-ended, reviewed after price moves",
  },
  "Dexs": {
    action: "Add liquidity to a pool",
    venue: "pool",
    asset: "ETH and USDC",
    recurring: "collect the pool fees and rebalance the range if the price moved out of it",
    exit: "remove the liquidity and keep the fee earnings",
    setupMinutes: 20,
    horizonAction:
      "Suggested horizon (a recommendation, not a protocol requirement): stay in while the pool's fees beat the alternatives you checked, and re-check after the price moves out of range.",
    horizonTime: "while the range earns (elapsed time, not active work)",
    horizonShort: "while the range earns",
  },
  "Liquidity Manager": {
    action: "Deposit into a managed liquidity position",
    venue: "vault",
    asset: "ETH and USDC",
    recurring: "check the manager's range and fee earnings, and stay in while the range earns",
    exit: "withdraw from the managed position back to the wallet",
    setupMinutes: 20,
    horizonAction:
      "Suggested horizon (a recommendation, not a protocol requirement): stay in while the managed range keeps earning fees, and re-check after the price moves out of range.",
    horizonTime: "while the range earns (elapsed time, not active work)",
    horizonShort: "while the range earns",
  },
  "Lending": {
    action: "Supply assets to the lending pool",
    venue: "pool",
    asset: "USDC",
    recurring: "claim the supply rewards and check the borrow rate before borrowing",
    exit: "withdraw the supplied assets and any unclaimed rewards",
  },
  "Uncollateralized Lending": {
    action: "Lend into an uncollateralized pool",
    venue: "pool",
    asset: "USDC",
    recurring: "check borrower repayments and the pool's default rate",
    exit: "withdraw the lent assets when the loan term ends",
    horizonAction:
      "Suggested horizon (a recommendation, not a protocol requirement): hold to the end of the loan term you funded, then decide whether to fund another term.",
    horizonTime: "the loan term (elapsed time, not active work)",
    horizonShort: "the loan term",
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
  "Leveraged Farming": {
    action: "Open a leveraged farming position",
    venue: "farm",
    asset: "ETH",
    recurring: "check the leverage ratio and the liquidation price, and deleverage if either moves against you",
    exit: "close the leveraged position and withdraw the collateral",
    setupMinutes: 20,
    cadence: "Twice a week",
    horizonAction:
      "Suggested horizon: none fixed — stay in only while the leverage ratio and liquidation price stay comfortable, and exit the moment they do not. This is a recommendation, not a protocol requirement.",
    horizonTime: "while the position stays safe (elapsed time, not active work)",
    horizonShort: "while the position stays safe",
  },
  "Basis Trading": {
    action: "Mint the basis position",
    venue: "position",
    asset: "ETH",
    recurring: "check the funding rate and the peg, and hold while the basis pays",
    exit: "redeem the position back to the underlying asset",
    setupMinutes: 20,
    cadence: "Twice a week",
    horizonAction:
      "Suggested horizon (a recommendation, not a protocol requirement): hold while the basis pays and the peg holds, and exit when either breaks.",
    horizonTime: "while the basis pays (elapsed time, not active work)",
    horizonShort: "while the basis pays",
  },
  "RWA": {
    action: "Buy a tokenized real-world position",
    venue: "offering",
    asset: "USDC",
    recurring: "check the issuer's attestation and the next payout date",
    exit: "redeem the position through the issuer's redemption flow",
    cadence: "Before each payout date",
    cadenceFreq: "per payout date",
    horizonAction:
      "Suggested horizon (a recommendation, not a protocol requirement): hold to the next payout date the issuer publishes, then re-check the attestation before deciding to stay.",
    horizonTime: "to the next published payout date (elapsed time, not active work)",
    horizonShort: "to the next payout date",
  },
  "Derivatives": {
    action: "Open a hedged derivatives position",
    venue: "market",
    asset: "USDC",
    recurring: "check the margin and the funding rate, and trim the position if either spikes",
    exit: "close the position and withdraw the margin",
    setupMinutes: 20,
    cadence: "Twice a week",
    horizonAction:
      "Suggested horizon (a recommendation, not a protocol requirement): hold while the margin and funding rate stay acceptable, and close the moment either spikes.",
    horizonTime: "while margin and funding stay acceptable (elapsed time, not active work)",
    horizonShort: "while margin and funding hold",
  },
  "Interest Rate Derivatives": {
    action: "Open a fixed-rate position",
    venue: "market",
    asset: "USDC",
    recurring: "check the fixed rate against the floating rate, and hold to maturity while the fixed rate pays",
    exit: "close the position at or after maturity and withdraw",
    setupMinutes: 20,
    cadence: "Each month",
    cadenceFreq: "a month",
    horizonAction:
      "Suggested horizon (a recommendation, not a protocol requirement): hold to the position's maturity if you entered for the fixed rate; exiting early depends on the market — check the current terms.",
    horizonTime: "to maturity (elapsed time, not active work)",
    horizonShort: "to maturity",
  },
  "Liquid Staking": {
    action: "Stake and hold the liquid staking token",
    venue: "staking pool",
    asset: "ETH",
    recurring: "restake the staking rewards and keep the receipt token in the wallet",
    exit: "unstake and allow for any unbonding delay the protocol states",
    setupMinutes: 10,
    horizonAction:
      "Suggested horizon (a recommendation, not a protocol requirement): hold the receipt token while the staking yield holds; before you enter, check whether the protocol states an unbonding delay — the snapshot states no lockup.",
    horizonTime: "as long as you hold the receipt token, plus any unstaking delay the protocol states (elapsed time, not active work)",
    horizonShort: "as long as you hold, plus any stated delay",
  },
  "Staking Pool": {
    action: "Stake into the pool",
    venue: "pool",
    asset: "ETH",
    recurring: "check the pool's yield and validator set, and restake the rewards",
    exit: "unstake and withdraw, allowing for any unbonding delay the pool states",
    setupMinutes: 10,
    horizonAction:
      "Suggested horizon (a recommendation, not a protocol requirement): stay staked while the pool's yield and validators perform; before you enter, check whether the pool states an unbonding delay — the snapshot states no lockup.",
    horizonTime: "as long as you stay staked, plus any unbonding delay the pool states (elapsed time, not active work)",
    horizonShort: "as long as staked, plus any stated delay",
  },
  "Restaking": {
    action: "Restake the receipt token with an operator",
    venue: "operator",
    asset: "ETH",
    recurring: "check the operator's uptime and slashing record, and switch operator if it slips",
    exit: "withdraw from the operator and unstake",
    setupMinutes: 20,
    horizonAction:
      "Suggested horizon (a recommendation, not a protocol requirement): stay staked while the operator performs; before you enter, check whether the protocol states an unbonding or withdrawal delay — the snapshot states no lockup.",
    horizonTime: "as long as you stay staked, plus any withdrawal delay the protocol states (elapsed time, not active work)",
    horizonShort: "as long as staked, plus any stated delay",
  },
  "Chain": {
    action: "Bridge funds in and use the chain's flagship app",
    venue: "app",
    asset: "USDC",
    recurring: "use one more native app so the wallet touches more of the chain",
    exit: "bridge the funds back out to the home chain",
    setupMinutes: 20,
    horizonAction:
      "Suggested horizon (a recommendation, not a protocol requirement): spread activity over several weeks so the wallet's history is not a single day.",
    horizonTime: "several weeks of activity (elapsed time, not active work)",
    horizonShort: "several weeks of activity",
  },
  "Cross Chain Bridge": {
    action: "Bridge assets to the destination chain and use the receiving app",
    venue: "bridge",
    asset: "USDC",
    recurring: "bridge a small amount on a new route so the wallet touches more routes",
    exit: "bridge the funds back to the home chain",
    setupMinutes: 20,
    horizonAction:
      "Suggested horizon (a recommendation, not a protocol requirement): spread bridge activity over several weeks and several routes rather than doing it all in one day.",
    horizonTime: "several weeks of activity (elapsed time, not active work)",
    horizonShort: "several weeks of activity",
  },
  "Farm": {
    action: "Deposit into the farm",
    venue: "farm",
    asset: "USDC",
    recurring: "harvest the farm rewards and stake them again while the rate holds",
    exit: "withdraw the deposit and the harvested rewards",
  },
  "Collateral Markets": {
    action: "Deposit collateral into a collateral market",
    venue: "market",
    asset: "ETH",
    recurring: "check the collateral ratio and the market's utilization, and top up before it nears liquidation",
    exit: "withdraw the collateral and repay any borrowing",
    setupMinutes: 25,
    horizonAction:
      "Suggested horizon (a recommendation, not a protocol requirement): keep the position open while the collateral ratio stays comfortable, and review it after any large price move.",
    horizonTime: "open-ended, reviewed after large price moves (elapsed time, not active work)",
    horizonShort: "open-ended, reviewed after price moves",
  },
  "Payments": {
    action: "Use the protocol for a real payment",
    venue: "app",
    asset: "USDC",
    recurring: "route one regular payment through the protocol",
    exit: "move the remaining balance back to the home wallet",
    setupMinutes: 10,
    horizonAction:
      "Suggested horizon (a recommendation, not a protocol requirement): use the protocol for regular payments over several weeks rather than once.",
    horizonTime: "several weeks of payments (elapsed time, not active work)",
    horizonShort: "several weeks of payments",
  },
  "Stablecoin Wrapper": {
    action: "Mint or buy the wrapped stablecoin",
    venue: "wrapper",
    asset: "USDC",
    recurring: "check the peg and the backing attestation, and hold while the peg holds",
    exit: "unwrap or redeem the stablecoin back to the underlying",
    horizonAction:
      "Suggested horizon (a recommendation, not a protocol requirement): hold while the peg holds and the backing attestation stays current.",
    horizonTime: "while the peg holds (elapsed time, not active work)",
    horizonShort: "while the peg holds",
  },
  "Dual-Token Stablecoin": {
    action: "Mint the stablecoin pair",
    venue: "minter",
    asset: "USDC",
    recurring: "check both tokens' pegs and the backing ratio",
    exit: "redeem the pair back to the underlying assets",
    horizonAction:
      "Suggested horizon (a recommendation, not a protocol requirement): hold while both pegs hold and the backing ratio stays healthy.",
    horizonTime: "while the pegs hold (elapsed time, not active work)",
    horizonShort: "while the pegs hold",
  },
  "OTC Marketplace": {
    action: "Place a limit order on the marketplace",
    venue: "market",
    asset: "USDC",
    recurring: "review open orders and reprice any that no longer match the market",
    exit: "cancel open orders and withdraw the balance",
    cadence: "Twice a week",
    horizonAction:
      "Suggested horizon (a recommendation, not a protocol requirement): keep orders working until they fill or the market moves away from your price.",
    horizonTime: "until orders fill or reprice (elapsed time, not active work)",
    horizonShort: "until orders fill or reprice",
  },
  "CeDeFi": {
    action: "Deposit into the managed yield product",
    venue: "product",
    asset: "USDC",
    recurring: "check the published yield source and the custodian's attestation",
    exit: "redeem the deposit through the product's withdrawal flow",
    horizonAction:
      "Suggested horizon (a recommendation, not a protocol requirement): hold through one full payout cycle the product publishes, then re-check the custodian attestation.",
    horizonTime: "one published payout cycle (elapsed time, not active work)",
    horizonShort: "one published payout cycle",
  },
  "Governance Incentives": {
    action: "Stake and vote in governance",
    venue: "governance",
    asset: "USDC",
    recurring: "vote on the proposal and claim the voting incentives",
    exit: "unstake after the voting period ends and withdraw",
    cadence: "When a new proposal opens",
    cadenceMinutes: 15,
    cadenceFreq: "per proposal",
    horizonAction:
      "Suggested horizon (a recommendation, not a protocol requirement): stay staked through the voting period whose incentives you want to claim.",
    horizonTime: "the voting period (elapsed time, not active work)",
    horizonShort: "the voting period",
  },
  "Insurance": {
    action: "Buy cover or provide cover capital",
    venue: "cover pool",
    asset: "USDC",
    recurring: "check open cover periods and claims, and renew cover before it lapses",
    exit: "withdraw the cover capital when no cover period is open",
    cadence: "Before each cover period ends",
    cadenceFreq: "per cover period",
    horizonAction:
      "Suggested horizon (a recommendation, not a protocol requirement): hold through the cover period you bought, and renew before it lapses if you want continuous cover.",
    horizonTime: "the cover period (elapsed time, not active work)",
    horizonShort: "the cover period",
  },
  "Anchor BTC": {
    action: "Deposit BTC into the anchor vault",
    venue: "vault",
    asset: "BTC",
    recurring: "check the peg of the receipt token and the vault's backing",
    exit: "redeem the receipt token back to BTC",
    horizonAction:
      "Suggested horizon (a recommendation, not a protocol requirement): hold while the receipt token's peg holds and the vault's backing stays sound.",
    horizonTime: "while the peg holds (elapsed time, not active work)",
    horizonShort: "while the peg holds",
  },
  "Decentralized BTC": {
    action: "Mint the decentralized BTC token against collateral",
    venue: "vault",
    asset: "BTC",
    recurring: "check the collateral ratio and the peg, and top up before liquidation risk rises",
    exit: "redeem the token and unlock the collateral",
    setupMinutes: 25,
    horizonAction:
      "Suggested horizon (a recommendation, not a protocol requirement): keep the position open while the collateral ratio stays comfortable, and review it after any large price move.",
    horizonTime: "open-ended, reviewed after large price moves (elapsed time, not active work)",
    horizonShort: "open-ended, reviewed after price moves",
  },
  "Crypto Card Issuer": {
    action: "Order the card and fund it",
    venue: "card",
    asset: "USDC",
    recurring: "spend through the card so the account shows real usage",
    exit: "spend down or withdraw the card balance",
    horizonAction:
      "Suggested horizon (a recommendation, not a protocol requirement): use the card for regular spending over several weeks rather than once.",
    horizonTime: "several weeks of spending (elapsed time, not active work)",
    horizonShort: "several weeks of spending",
  },
  "Indexes": {
    action: "Buy the index token",
    venue: "index",
    asset: "USDC",
    recurring: "check the new index composition and rebalance dates",
    exit: "sell the index token back to the underlying assets",
    cadence: "After each rebalance",
    cadenceFreq: "per rebalance",
    horizonAction:
      "Suggested horizon (a recommendation, not a protocol requirement): hold through at least one rebalance to see the composition change.",
    horizonTime: "through one rebalance (elapsed time, not active work)",
    horizonShort: "through one rebalance",
  },
};

// Protocol-specific exceptions: only where the category template is
// plainly wrong for the protocol AND the correction follows from the
// protocol's own mechanism as the snapshot names it (its name, its
// chain, its category). Each exception is flagged in NOTES-R3.md with
// its basis; anything not verifiable this way keeps the category
// template. No exception states a holding period, lockup, reward, or
// eligibility rule.
const EXCEPTIONS: Record<string, Partial<CategoryPlay>> = {
  "lightning-network": {
    action: "Open a Lightning channel from a Lightning wallet",
    venue: "channel",
    asset: "BTC",
    recurring: "route payments through the channel and rebalance it when one side runs dry",
    exit: "close the channel and settle the balance back on-chain",
    setupMinutes: 20,
    horizonAction:
      "Suggested horizon (a recommendation, not a protocol requirement): keep the channel open across several weeks of payments rather than opening and closing it in a day.",
    horizonTime: "several weeks with the channel open (elapsed time, not active work)",
    horizonShort: "several weeks with the channel open",
    wallet:
      "Use a Lightning wallet you control, funded only with what you plan to use with {name}, and keep its seed phrase offline on paper",
    step2:
      "Open a Lightning channel funded with ${big} of BTC from a Lightning wallet on {chain1} and keep the channel receipt in the same wallet",
  },
  "bittensor-dtao": {
    action: "Stake TAO into a subnet through the dTAO staking flow",
    venue: "subnet",
    asset: "TAO",
    recurring: "check the subnet's emissions and the validators you staked with, and move stake if performance slips",
    exit: "unstake the TAO back to the wallet",
    setupMinutes: 20,
    horizonAction:
      "Suggested horizon (a recommendation, not a protocol requirement): stay staked while the subnet's emissions and validators perform; move stake rather than exiting outright when performance slips.",
    horizonTime: "as long as the subnet performs (elapsed time, not active work)",
    horizonShort: "as long as the subnet performs",
    step2:
      "Stake ${big} of TAO into a subnet through the dTAO staking flow on {chain1} and keep the receipt in the same wallet",
  },
  noble: {
    action: "Move native USDC onto Noble over IBC and hold it there",
    asset: "USDC",
    recurring: "use one more Noble-native transfer or app so the wallet shows real usage",
    exit: "transfer the USDC out over IBC to the home chain",
    setupMinutes: 20,
    horizonAction:
      "Suggested horizon (a recommendation, not a protocol requirement): hold the USDC on Noble across several weeks of transfers rather than moving it in and straight back out.",
    horizonTime: "several weeks of transfers (elapsed time, not active work)",
    horizonShort: "several weeks of transfers",
    step2:
      "Move ${big} of native USDC onto Noble over IBC and hold it there, keeping the transfer receipt in the same wallet",
  },
};

const DEFAULT_WALLET =
  "Use a fresh wallet that holds only the funds you plan to farm with {name}, and keep its seed phrase offline on paper";

function tier(amount: number): { big: number; small: number } {
  if (amount >= 1_000_000_000) return { big: 200, small: 100 };
  if (amount >= 100_000_000) return { big: 120, small: 60 };
  return { big: 60, small: 30 };
}

// Network-fee estimate for the protocol's chains, labeled as an
// estimate: Ethereum transactions cost materially more than other
// chains', and Bitcoin fees are on-chain fees, not gas.
function feeFor(chains: string[]): { phrase: string; setupTotal: string } {
  if (chains.includes("Ethereum")) {
    return { phrase: "an estimated $8 of network fees", setupTotal: "about $19" };
  }
  if (chains.includes("Bitcoin")) {
    return { phrase: "an estimated few dollars of on-chain fees", setupTotal: "a few dollars" };
  }
  return { phrase: "an estimated $2 of network fees", setupTotal: "about $7" };
}

interface FarmPlan {
  steps: string[];
  summary: string;
}

function farmPlan(p: SnapshotProtocol): FarmPlan {
  const play: CategoryPlay = {
    ...DEFAULT_PLAY,
    ...(PLAYS[p.category] ?? {}),
    ...(EXCEPTIONS[p.slug] ?? {}),
  };
  const chain1 = p.chains[0] ?? "Ethereum";
  const chain2 = p.chains[1] ?? chain1;
  const { big, small } = tier(p.tvl_usd);
  const fee = feeFor(p.chains);
  const wallet = (play.wallet ?? DEFAULT_WALLET).replaceAll("{name}", p.name);
  const step2Head = play.step2
    ? play.step2.replaceAll("{big}", String(big)).replaceAll("{chain1}", chain1)
    : `${play.action} with $${big} of ${play.asset} in the ${p.name} ${play.venue} on ${chain1} and keep the receipt in the same wallet`;
  // A protocol on a single chain cannot repeat the position "on more
  // than one chain": the second position goes to another venue on the
  // same chain instead.
  const step3Head =
    chain2 !== chain1
      ? `Repeat a smaller position of about $${small} on ${chain2} so the activity is visible on more than one chain`
      : `Open a second, smaller position of about $${small} in another ${play.venue} on ${chain1} so the activity is not one single position`;
  const steps = [
    `${wallet}. Cost: under $3 of network fees (estimate) for the first transaction on ${chain1}. Time: 5 minutes.`,
    `${step2Head}. Cost: $${big} of capital and ${fee.phrase}. Time: about ${play.setupMinutes} minutes to set up.`,
    `${step3Head}. Cost: about $${small} of capital and ${fee.phrase}. Time: 15 minutes.`,
    `${play.cadence}, ${play.recurring}. Cost: ${fee.phrase} when the recurring action needs a transaction; checking is free. Time: about ${play.cadenceMinutes} minutes each time.`,
    `${play.horizonAction} Cost: the $${big} stays in the position for the horizon. Time: ${play.horizonTime}.`,
    `Before you withdraw, check whether ${p.name} publishes a points or rewards page, and claim only from a link it publishes. Cost: no fee to check, and never pay to claim. Time: 10 minutes.`,
    `Never connect the farm wallet to a link from a direct message, and never pay anyone to claim or to speed up a reward from ${p.name}. Cost: nothing, and it saves the whole position. Time: 1 minute to check the domain.`,
    `Write the wallet, the dates and every transaction in a farm log, then ${play.exit} when you are done. Cost: nothing but the log. Time: 5 minutes to write, 15 minutes to unwind, plus any withdrawal delay the protocol states.`,
  ];
  const setupMinutes = 5 + play.setupMinutes + 15 + 10 + 1 + 20;
  const placement =
    chain2 !== chain1 ? `across ${chain1} and ${chain2}` : `on ${chain1}`;
  const summary =
    `Capital $${big} + $${small} ${placement} (your funds in the positions, not a fee) · ` +
    `setup network fees ${fee.setupTotal} (estimate) · ` +
    `about ${setupMinutes} minutes of active work to set up and unwind, then about ${play.cadenceMinutes} minutes ${play.cadenceFreq} · ` +
    `suggested horizon: ${play.horizonShort} (a recommendation, not a protocol requirement).`;
  return { steps, summary };
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

  const rows: BoardRow[] = scored.map((s, i) => {
    const plan = farmPlan(s.p);
    return {
      slug: s.p.slug,
      name: s.p.name,
      rank: i + 1,
      category: s.p.category,
      chains: s.p.chains,
      chain_count: s.p.chains.length,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      listed_at: s.p.listed_at ?? "",
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
      farm_steps: plan.steps,
      plan_summary: plan.summary,
      watchlist: watchlist.has(s.p.slug),
    };
  });

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

  // Reconcile every protocol in the snapshot: ranked, a live-token
  // comparable, or set aside with the first excluding reason. The
  // "other" bucket must stay empty: anything passing every filter is
  // a candidate and therefore ranked.
  const rankedSlugs = new Set(rows.map((r) => r.slug));
  const liveSlugs = new Set(live.map((p) => p.slug));
  const setAside = {
    has_token: 0,
    blocked_category: 0,
    versioned_name: 0,
    staking_name: 0,
    below_floor: 0,
    other: 0,
  };
  for (const p of snapshot.protocols) {
    if (rankedSlugs.has(p.slug) || liveSlugs.has(p.slug)) continue;
    if (hasToken(p)) setAside.has_token++;
    else if (BLOCKED_CATEGORIES.has(p.category)) setAside.blocked_category++;
    else if (VERSIONED_NAME.test(p.name)) setAside.versioned_name++;
    else if (STAKING_NAME.test(p.name)) setAside.staking_name++;
    else if (p.tvl_usd < EARLY_MIN_TVL) setAside.below_floor++;
    else setAside.other++;
  }
  const accounting: Accounting = {
    snapshot_n: snapshot.protocols.length,
    ranked_n: rows.length,
    live_n: live.length,
    set_aside_n: snapshot.protocols.length - rows.length - live.length,
    watchlist_n: snapshot.watchlist.length,
    watchlist_with_token: snapshot.watchlist.filter((slug) => {
      const p = snapshot.protocols.find((x) => x.slug === slug);
      return p !== undefined && hasToken(p);
    }).length,
    set_aside: setAside,
  };

  const totalImplied = rows.reduce((sum, r) => sum + r.implied_value_usd, 0);
  return {
    rows,
    live: liveRows,
    as_of: snapshot.as_of,
    total_implied: totalImplied,
    median_multiple: median(rows.map((r) => r.multiple)),
    global_median: globalMedian,
    live_n: live.length,
    accounting,
  };
}
