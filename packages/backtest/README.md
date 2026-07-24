# @log/backtest

A dedicated, deterministic **backtest** for the validation engine — the measurement
that turns "no hallucination / no false positives / no false negatives" from a claim
into a **bounded, monitored number**.

It replays a hand-labelled gold-set corpus through the **real** validation engine (the
exact code the deployed validation poller runs, minus DB I/O) and scores it with a
confusion matrix, per application and per failure mode.

## Architecture (who owns what)

| Layer | Lives in | Contents |
|---|---|---|
| Generic contract | `@log/shared` (`backtest.ts`) | `GoldCase`, `FailureMode`, `makeParsedLog` |
| **App cases + fixtures** | `@log/app-scp`, `@log/app-apiflc` (`./backtest` subpath) | `scpGoldCases`, `apiflcGoldCases` and their real-shaped log fixtures |
| Runner (this package) | `@log/backtest` | engine adapter, metrics, report, CLI, corpus aggregator |

App-specific cases live in the **app packages** — mirroring how each app already owns
its protocol, prompts, cross-log-group join, and validation checks. They never leak
into shared or into the production bundle (they are reached only via the `./backtest`
subpath, imported only by this dev-only package).

## The failure modes each case guards

- **clean** — a healthy transaction the engine must NOT flag.
- **false-positive** — looks suspicious but is correct; the engine must stay quiet.
- **false-negative** — genuinely broken; the engine MUST flag it.
- **hallucination** — the agent recorded something its own logs contradict (a 500 as
  `completed`, a fabricated phase); caught by re-deriving the outcome from the raw logs.

## Run it

```bash
npm run backtest --workspace @log/backtest            # prints the report, exits non-zero on any FP/FN
npm run backtest --workspace @log/backtest -- --json report.json
npm test --workspace @log/backtest                    # the same corpus as node:test assertions (CI gate)
```

## Add a case

Edit the owning app's `src/backtestCases.ts` (e.g. `packages/apps/scp/src/backtestCases.ts`).
Every production incident where the validator was ever wrong should become a case here —
each one is then a permanent regression guard.

## Add an application

Give the app a `./backtest` subpath export of its `<app>GoldCases`, then add one
import + spread in `src/corpus.ts`.
