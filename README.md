# DePIN Reward Float

Stablecoin microcredit for DePIN hardware operators, underwritten against **future**
token rewards and priced from the verified on-chain history of the payouts they have
already received.

An operator who wants a second Hivemapper dashcam or Helium hotspot hits a capital wall:
the hardware costs money today and pays for itself in a stream of small token rewards over
months. Lending markets only accept liquid collateral the operator does not have, RWA
wrappers sell a share of the hardware to investors instead of financing the operator, and
a bank sees no income at all. Meanwhile the operator carries the best credit trail there
is — a public, immutable, second-by-second payout record sitting in the chain — and
nothing reads it.

This repository reads it.

## Status

Milestone **M1 — truth of the data**. Everything the interface shows about a wallet is
derived from mainnet, but no money moves yet.

What works end to end:

- payouts of supported networks are classified and indexed from mainnet — the indexer
  invoked by hand, see below — third-party transfers of the same token excluded;
- monthly payout history and a per-network credit limit are served over HTTP and
  rendered in the browser;
- a refused limit states its reason as structured data, not prose.

What is deliberately not here yet:

- **no lending.** The limit is a number nobody underwrites at drawdown, because there is
  no drawdown. The on-chain program (`programs/reward-float`) declares its id and nothing
  else — pool, loans and reward withholding land in a later milestone.
- **`/offer` is a mock.** The page says so on screen.
- **the indexer has no runnable entry point, and the keeper has no code.** The indexer's
  logic is written and tested; `apps/worker/src/indexer/index.ts` re-exports it and does
  not run it, and nothing in `apps/worker` reads a single environment variable. The
  database is populated by calling those functions directly. `apps/worker/src/keeper` is
  an empty module.
- **migrations and seeding are exported, not wired.** `migrateToLatest` and `seedNetworks`
  are called by hand.
- **nothing is signed yet.** `packages/shared/src/attestation` and `packages/anchor-client`
  are empty modules. The API refuses to start without an attestor key, but never uses it.

## How the limit is derived

```
mainnet RPC → classify transfers → monthly aggregate → eligibility → factors → limit
```

A transfer counts as a reward only when it comes from a network's known payout source,
carries that network's mint, is addressed to the operator and is non-zero. Everything else
is ignored with a named reason, and that classifier is held to zero misclassifications on
recorded real wallets (`packages/shared/src/scoring/classify.spec.ts`, fixtures in
`fixtures/wallets.json`).

Each payout is valued in dollars at the DefiLlama quote for the day it landed
(`coins.llama.fi`, no key required), cached in `price_points`. A day without a quote is
kept as a payout with no dollar value rather than dropped.

Eligible history is six paid months out of the last twelve — not necessarily consecutive.
Below that, the limit is refused with the month the threshold will be reached, rather than
reported as zero: a limit of nothing and no limit at all are different statements.

The limit itself is per network, never one number per wallet: HONEY and HNT are not
comparable in sign count, price or volatility, and a single figure would have to add up
values that do not add. Three factors explain it — median flow raises it, instability and
volatility lower it — and each is returned with its own signed contribution in
microdollars.

## Supported networks

| Network | Token | Payout shape | Limit |
|---|---|---|---|
| Hivemapper | HONEY | weekly, minted at payout time | computed |
| Helium | HNT | claimed on demand by the operator | refused — `withdrawal-history` |

Helium is indexed and its history is shown, but no limit is derived from it. What the
chain holds there is a record of **withdrawals**, not of earnings: the rhythm belongs to
the operator, so stability measured on it would describe when someone chose to click, not
how reliably the hardware earns.

Networks live as data in `packages/shared/src/schemas/supported.ts`, with every address
checked against mainnet.

## Repository layout

```
apps/api          Hono HTTP service — payout history, credit limit, health
apps/web          React 19 + Vite operator dashboard
apps/worker       indexer (reads mainnet); keeper (writes devnet) is an empty module
packages/shared   Zod schemas, classifier, scoring — no I/O
packages/db       Drizzle schema, migrations, seed
packages/anchor-client  client for the on-chain program (empty until it has instructions)
programs/reward-float   Anchor program (declared, not implemented)
tests             live and browser measurements, kept out of the gate
```

The `indexer` reads **mainnet** and the `keeper` writes **devnet**. These are two separate
endpoints in the configuration rather than one network switch, because a single switch
eventually gets pointed at the wrong chain.

The credit limit is computed off-chain. The program will never trust a number from the API
on its word — it arrives as a signed attestation and the signature is verified on chain.
The attestor key lives only in the `api` process.

## Getting started

Requires Node ≥ 24.2 and pnpm 9.15, plus a Postgres database.

```bash
pnpm install
cp .env.example .env       # then fill in the placeholders
pnpm gate                  # lint + typecheck + test — green before every commit
```

Apply the migrations and seed the supported networks by calling `migrateToLatest` and
`seedNetworks` from `@drf/db` against your `DATABASE_URL`. A schema change becomes a
migration with `pnpm --filter @drf/db db:generate`.

Run the two processes:

```bash
pnpm --filter @drf/api start     # http://localhost:8787
pnpm --filter @drf/web dev       # http://localhost:5173
```

The page and the API always sit on different origins, so the API only answers browsers
whose origin is listed in `WEB_ORIGIN` (comma-separated; an empty list is rejected at
startup). `VITE_API_URL` is read at build time and is baked into the bundle — nothing
secret belongs in it.

### Environment

`.env.example` is the full list. What M1 actually reads:

| Variable | Read by | Meaning |
|---|---|---|
| `DATABASE_URL` | api | Postgres connection string |
| `ATTESTOR_SECRET_KEY`, `ATTESTOR_PUBLIC_KEY` | api | ed25519, base58 — required at startup, unused until attestations exist |
| `WEB_ORIGIN` | api | origins allowed to read the API |
| `PORT`, `LOG_LEVEL` | api | defaults `8787` and `info` |
| `VITE_API_URL` | web | where the page fetches from |

`MAINNET_RPC_URL`, `DEVNET_RPC_URL`, `KEEPER_SECRET_KEY`, `PROGRAM_ID` and `STABLE_MINT`
are reserved for the worker and the program; nothing reads them yet. Prices need no
variable at all.

Whoever holds `ATTESTOR_SECRET_KEY` will be able to issue any limit. It never belongs in
the repository and never in `web`.

## HTTP API

| Method | Path | Answers |
|---|---|---|
| `GET` | `/health` | liveness only — it does not touch the database |
| `GET` | `/health/payout-sources` | per source, whether payouts are still arriving |
| `GET` | `/v1/operators/:address/payouts` | monthly payout history per network |
| `GET` | `/v1/operators/:address/limit` | credit limit with factors, or a refusal |
| `POST` | `/v1/operators/:address/limit/refresh` | recompute the limit now, expired or not |

A computed limit is stored and served as is for 24 hours (`expiresAt` in the response).
Once any network's entry has expired, the next `GET` recomputes the whole wallet;
`POST …/refresh` does not wait for that.

Errors follow `{ "error": { "code": ..., "message": ... } }`. `DATA_UNAVAILABLE` is kept
apart from every other failure on purpose: "we could not read the chain" must never reach
the operator looking like "your limit is zero".

`/health/payout-sources` answers `200` with the state in the body rather than `503`,
because in this service `503` already means the data could not be read, and the two must
not be confused. A source nobody has indexed yet does not raise an alarm — otherwise every
fresh deployment would start out screaming.

## Web

| Route | Shows |
|---|---|
| `/lookup` | enter or connect a wallet |
| `/history/:address` | monthly payouts per network |
| `/limit/:address` | the limit, its factors, or the refusal |
| `/offer` | mock — labelled as such on the page |

The address lives in the path because payout history is public; a connected wallet is just
one address among them.

## Tests and measurements

```bash
pnpm gate          # lint, typecheck and the full test suite
pnpm bench:limit   # latency measurements — NOT part of the gate
```

The benchmarks are excluded from the gate deliberately: they write hundreds of rows into a
live database and cost tens of seconds per commit. They measure the cold path — an
operator who has just connected a wallet has no stored profile by definition — and report
p95 by nearest rank, without interpolation. An empty sample throws instead of returning
zero, since zero would pass any budget.

Last run: first screen p95 **1664 ms** against a 2000 ms budget; server-side limit p95
**687 ms** against 10 s.

## On-chain program

Anchor 0.32.1 on Rust 1.97.1. Tests use `mollusk-svm` 0.15 — `litesvm` does not build
against this Anchor version. `overflow-checks = true` stays on in release builds.

On Windows the program is built inside WSL, invoked from PowerShell (Git Bash mangles the
`/mnt/` path):

```powershell
wsl.exe -e bash /mnt/<path-to-repo>/scripts/wsl-build.sh
```
