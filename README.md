# Kopler TrendForge BTC

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603)

A trend-following trading bot for Coinbase Wrapped BTC (CBBTC) against USDC on 1-minute bars,
built for the make.fun `bars-replay/v1` harness. It starts with 1,000 USDC of paper money,
trades long only, and holds at most one position.

## Strategy

TrendForge only buys strength inside a confirmed uptrend, and gets out as soon as that
story breaks:

- **Trend filter** — three EMAs of the close: fast (10 bars), slow (40 bars) and a long
  regime EMA (120 bars). A trend entry needs the fast EMA above the slow EMA and the close
  above the long EMA.
- **Momentum confirmation** — the 12-bar rate of change must be positive and Wilder RSI(14)
  must be below 72, so sideways chop and overbought exhaustion are not bought.
- **Dip entries** — inside the same uptrend (30-bar momentum still positive), an RSI(14)
  reading at or below 32 is bought as a pullback, at 50% of the normal size.
- **Volatility sizing** — stake scales inversely with an ATR-like average true range as a
  share of price (target 0.12% per bar), clamped between 30% and 97% of equity, so quiet
  trends get a near-full stake and violent bars get a small one.
- **Patient exits** — one-minute BTC is mostly chop and a round trip costs ~26 bps, so the
  trend exit demands persistence: the fast EMA below the slow EMA with the close under the
  long EMA for 120 consecutive bars (a cross-down that proves itself a regime change).
  Around it sit the protective exits: a trailing stop 4% under the peak close since entry,
  a hard stop at −5.5% of entry value, a take-profit at +12%, and an extreme-overbought
  exit at RSI(14) ≥ 85, which on 1-minute bars only happens at genuine spike tops. A 30-bar
  cooldown after each exit cuts fee churn in flat markets.

Orders are decided on each bar's close and fill at the next bar's open, with slippage capped
at 80 bps. Sells are always listed before buys, order counts respect the harness cap, and no
orders are sent during warm-up. All indicator math is deterministic float arithmetic — no
clock, no randomness — so repeated runs over the same bars produce identical orders.

## Layout

- `main.ts` — the bot (entrypoint, run with Node 22: `node main.ts`)
- `vendor/makefun-bars.ts` — the kit's `bars-replay/v1` SDK shim, vendored byte-identical

## License

MIT — see `LICENSE`.
