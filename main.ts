// Kopler TrendForge BTC — a trend-riding bot for the bars-replay/v1 harness.
//
// It trades one symbol (CBBTC against USDC, one bar per minute) long only, starting from the
// capital the hello message grants. Every batch brings one new bar; the bot answers with orders
// that fill at the next bar's open, so every decision below is made on closes only.
//
// Design notes (all parameters chosen for robustness on unseen prices, not fit to one window):
// one-minute BTC is mostly chop, and a round trip costs roughly 26 bps in fees, slippage and
// price impact, so a bot that trades every wiggle pays the pool, not itself. TrendForge
// therefore enters rarely, only inside a confirmed uptrend, and then rides the position: its
// exits demand real evidence that the trend is over, not a single noisy cross. The protective
// exits (hard stop, take-profit, trailing stop, extreme-overbought exit) sit far enough away
// to guard against genuine regime breaks without churning the account in sideways bars.
//
//   - Trend filter: three EMAs of the closes — fast (10 bars), slow (40 bars) and a long
//     regime EMA (120 bars). A trend entry needs the fast EMA above the slow EMA, the close
//     above the long EMA, positive 12-bar momentum (ROC) and RSI(14) below 72, so strength is
//     bought inside a confirmed uptrend, never exhaustion at a spike top.
//   - Dip entry (second mode, half size): the same uptrend (close above the long EMA, fast
//     EMA above the slow EMA, 30-bar ROC still positive) with RSI(14) at or below 32 — a
//     pullback inside a trend that is still intact, bought at a reduced stake.
//   - Volatility sizing: the stake scales inversely with an ATR-like average true range as a
//     share of price (target 0.12% per bar), clamped between 30% and 97% of equity and by the
//     hello caps (caps.max_weight_bps) and the cash actually held.
//   - Exits, first one that fires sells the whole position:
//       * trend death: the fast EMA below the slow EMA with the close below the long EMA
//         for 120 consecutive bars — a cross-down that persists is a regime change; one
//         that lasts a few bars in chop is noise and is ridden through;
//       * a hard stop at about 5.5% under the entry value;
//       * a take-profit at about 12% over the entry value;
//       * a trailing stop 4% under the peak close since entry;
//       * RSI(14) at or above 85: an extreme-overbought blow-off exit (on 1-minute bars
//         RSI only reaches the mid-80s at genuine spike tops).
//     After any exit the bot sits out a 30-bar cooldown before it may enter again, which
//     keeps fee churn down when the market goes sideways after a sale.
//   - Orders respect the hello caps and fees: at most caps.max_orders_per_bar orders per
//     reply, sells listed before buys, no buy below fees.min_notional_quote_units, and no
//     orders at all while state.warmingUp. Slippage is capped at 80 bps past the close the
//     order was decided on.
//   - All indicator math is float64 built from + - * / and comparisons only, each step
//     correctly rounded, so two runs over the same bars send byte-identical orders. Nothing
//     reads the clock, the environment or a random source.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const FAST_SPAN = 10;
const SLOW_SPAN = 40;
const LONG_SPAN = 120;
const RSI_BARS = 14;
const ROC_BARS = 12;
const DIP_ROC_BARS = 30;
const ATR_BARS = 14;
const MAX_SLIPPAGE_BPS = 80;

/** Trend entry: RSI must stay below this, so strength is bought, not exhaustion. */
const RSI_TREND_MAX = 72;
/** Dip entry: RSI at or below this, while the uptrend filter still holds. */
const RSI_DIP_MAX = 32;
/** Extreme-overbought exit: RSI at or above this closes the position. */
const RSI_EXIT_MIN = 85;
/** Consecutive bars of fast-below-slow with the close under the long EMA that prove trend death. */
const TREND_DEATH_BARS = 120;
/** Hard stop: value at or below entry cost times (1 - STOP_PCT) exits. */
const STOP_PCT = 0.055;
/** Take-profit: value at or above entry cost times (1 + TAKE_PCT) exits. */
const TAKE_PCT = 0.12;
/** Trailing stop: a close this share under the peak close since entry exits. */
const TRAIL_PCT = 0.04;
/** Bars to sit out after an exit before a new entry is allowed. */
const COOLDOWN_BARS = 30;
/** Dip entries risk this share of the size a trend entry would take. */
const DIP_SIZE_SHARE = 0.5;
/** Target per-bar volatility (ATR as a share of price) for a full-size stake. */
const TARGET_ATR_SHARE = 0.0012;
/** Size clamps: never less than this share of equity, never more than this share. */
const MIN_SIZE_SHARE = 0.3;
const MAX_SIZE_SHARE = 0.97;

interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

interface Series {
  fast: Ema;
  slow: Ema;
  long: Ema;
  /** Closes kept for the ROC lookbacks, oldest first, at most DIP_ROC_BARS + 1. */
  closes: number[];
  /** Wilder RSI state: seed changes, then the smoothed averages. */
  seed: number[];
  avgGain: number | null;
  avgLoss: number | null;
  lastClose: number | null;
  /** Previous bar's high/low/close for the true range. */
  prevBar: { h: number; l: number; c: number } | null;
  /** Wilder-smoothed true range and how many ranges fed it. */
  atr: number | null;
  atrCount: number;
  atrSeed: number;
}

function makeEma(span: number): Ema {
  return { span, warm: [], value: null };
}

function stepEma(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) {
    let sum = 0;
    for (const x of e.warm) sum += x;
    e.value = sum / e.span;
  }
}

const series: Series = {
  fast: makeEma(FAST_SPAN),
  slow: makeEma(SLOW_SPAN),
  long: makeEma(LONG_SPAN),
  closes: [],
  seed: [],
  avgGain: null,
  avgLoss: null,
  lastClose: null,
  prevBar: null,
  atr: null,
  atrCount: 0,
  atrSeed: 0,
};

/** Fold one bar into every indicator; returns the close for convenience. */
function pushBar(bar: Bar): number {
  const h = Number(bar.h);
  const l = Number(bar.l);
  const c = Number(bar.c);
  const s = series;

  stepEma(s.fast, c);
  stepEma(s.slow, c);
  stepEma(s.long, c);

  s.closes.push(c);
  if (s.closes.length > DIP_ROC_BARS + 1) s.closes.shift();

  if (s.lastClose !== null) {
    const change = c - s.lastClose;
    const up = change > 0 ? change : 0;
    const down = change < 0 ? -change : 0;
    if (s.avgGain === null || s.avgLoss === null) {
      s.seed.push(change);
      if (s.seed.length === RSI_BARS) {
        let g = 0;
        let d = 0;
        for (const x of s.seed) {
          if (x > 0) g += x;
          else d -= x;
        }
        s.avgGain = g / RSI_BARS;
        s.avgLoss = d / RSI_BARS;
      }
    } else {
      s.avgGain = (s.avgGain * (RSI_BARS - 1) + up) / RSI_BARS;
      s.avgLoss = (s.avgLoss * (RSI_BARS - 1) + down) / RSI_BARS;
    }
  }
  s.lastClose = c;

  if (s.prevBar !== null) {
    let tr = h - l;
    const hc = h - s.prevBar.c;
    const lc = s.prevBar.c - l;
    const aHc = hc < 0 ? -hc : hc;
    const aLc = lc < 0 ? -lc : lc;
    if (aHc > tr) tr = aHc;
    if (aLc > tr) tr = aLc;
    if (s.atr === null) {
      s.atrSeed += tr;
      s.atrCount++;
      if (s.atrCount === ATR_BARS) s.atr = s.atrSeed / ATR_BARS;
    } else {
      s.atr = (s.atr * (ATR_BARS - 1) + tr) / ATR_BARS;
    }
  }
  s.prevBar = { h, l, c };
  return c;
}

function rsiNow(): number | null {
  const s = series;
  if (s.avgGain === null || s.avgLoss === null) return null;
  const moved = s.avgGain + s.avgLoss;
  return moved === 0 ? 50 : (100 * s.avgGain) / moved;
}

/** Rate of change over `bars` bars, or null before enough closes exist. */
function rocNow(bars: number): number | null {
  const s = series;
  if (s.closes.length <= bars) return null;
  const past = s.closes[s.closes.length - 1 - bars]!;
  const now = s.closes[s.closes.length - 1]!;
  return past === 0 ? null : now / past - 1;
}

/** Stake for a new entry, in quote units: volatility-scaled, weight- and cash-capped. */
function stakeFor(state: BarsState, share: number): bigint {
  const s = series;
  let volScale = 1;
  if (s.atr !== null && s.lastClose !== null && s.lastClose > 0) {
    const atrShare = s.atr / s.lastClose;
    if (atrShare > 0) volScale = TARGET_ATR_SHARE / atrShare;
  }
  if (volScale > 1) volScale = 1;
  let frac = MAX_SIZE_SHARE * volScale * share;
  if (frac < MIN_SIZE_SHARE * share) frac = MIN_SIZE_SHARE * share;
  if (frac > MAX_SIZE_SHARE) frac = MAX_SIZE_SHARE;
  let stake = BigInt(Math.floor(Number(state.equity) * frac));
  const byWeight = (BigInt(state.hello.caps.max_weight_bps) * state.equity) / BPS;
  if (stake > byWeight) stake = byWeight;
  if (stake > state.cash) stake = state.cash;
  return stake;
}

// Position bookkeeping: the peak close while holding (for the trailing stop), the run of
// consecutive trend-death bars, and the post-exit cooldown. The harness stays the source of
// truth for quantity and cost; these only remember prices seen while holding.
let peakClose: number | null = null;
let wasHolding = false;
let deathRun = 0;
let cooldownUntil = -1;

await runBars({
  onBatch(state, batch) {
    let close: number | null = null;
    let sawBar = false;
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      close = pushBar(bar);
      sawBar = true;
    }
    if (state.warmingUp || !sawBar || close === null) return [];

    const { caps, fees } = state.hello;
    const held = state.positions.get(SYMBOL);
    const orders: (SellInput | BuyInput)[] = [];

    if (held === undefined) {
      wasHolding = false;
      peakClose = null;
      deathRun = 0;
    } else {
      if (!wasHolding || peakClose === null) peakClose = close;
      else if (close > peakClose) peakClose = close;
      wasHolding = true;
    }

    // Exits first: a sell decided on this batch is listed before any buy, and its proceeds
    // never fund a buy in the same reply anyway.
    if (held !== undefined) {
      const value = state.value(SYMBOL, held.qty);
      const rsi = rsiNow();
      const trendDeadNow =
        series.fast.value !== null && series.slow.value !== null && series.long.value !== null &&
        series.fast.value < series.slow.value && close < series.long.value;
      deathRun = trendDeadNow ? deathRun + 1 : 0;
      let exit = false;
      if (deathRun >= TREND_DEATH_BARS) exit = true;
      if (value * 1000n <= held.cost * BigInt(Math.floor((1 - STOP_PCT) * 1000))) exit = true;
      if (value * 1000n >= held.cost * BigInt(Math.floor((1 + TAKE_PCT) * 1000))) exit = true;
      if (peakClose !== null && close <= peakClose * (1 - TRAIL_PCT)) exit = true;
      if (rsi !== null && rsi >= RSI_EXIT_MIN) exit = true;
      if (exit) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        cooldownUntil = state.seq + COOLDOWN_BARS;
        deathRun = 0;
        return orders.slice(0, caps.max_orders_per_bar);
      }
      return [];
    }

    // Entries: only when flat, past the cooldown, and every indicator is seeded.
    if (state.seq <= cooldownUntil) return [];
    if (series.fast.value === null || series.slow.value === null || series.long.value === null) return [];
    const rsi = rsiNow();
    const roc = rocNow(ROC_BARS);
    if (rsi === null || roc === null) return [];

    const aboveLong = close > series.long.value;
    const fastAboveSlow = series.fast.value > series.slow.value;
    let share = 0;
    if (aboveLong && fastAboveSlow && roc > 0 && rsi < RSI_TREND_MAX) {
      share = 1;
    } else if (aboveLong && fastAboveSlow && rsi <= RSI_DIP_MAX) {
      const dipRoc = rocNow(DIP_ROC_BARS);
      if (dipRoc !== null && dipRoc > 0) share = DIP_SIZE_SHARE;
    }
    if (share === 0) return [];

    const stake = stakeFor(state, share);
    if (stake < BigInt(fees.min_notional_quote_units) || stake <= 0n) return [];
    orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: stake, max_slippage_bps: MAX_SLIPPAGE_BPS });
    return orders.slice(0, caps.max_orders_per_bar);
  },
});
