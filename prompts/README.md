# prompts/

The LLM **system prompts / instructions** used across the platform, externalized
from code into editable `.md` files. Each file is the exact `system` string sent
to Bedrock for one call site. Code loads them at runtime via `loadPrompt(<path>)`
from `@log/shared` (see [packages/shared/src/prompts.ts](../packages/shared/src/prompts.ts)).

| File | Loaded by | Role |
|------|-----------|------|
| [agents/supervisor.md](agents/supervisor.md) | `packages/agents/src/supervisor.ts` | Supervisor routing: parse intent + params, pick one collaborator agent. |
| [analysis/reason.md](analysis/reason.md) | `packages/analysis/src/reason.ts` | Reason over a correlated log cluster into a Finding (strictly log-grounded). |
| [analysis/transactions.md](analysis/transactions.md) | `packages/analysis/src/transactions.ts` | Reason over a flagged FRB cashMessage transaction into a Finding. |
| [api/analyze.md](api/analyze.md) | `packages/api/src/analyze.ts` | Answer a raw-log analytical question from aggregates + a messages table. |
| [api/chat.md](api/chat.md) | `packages/api/src/chat.ts` | Scoped chat assistant: answer only from retrieved findings/logs. |
| [api/simulate.segment.md](api/simulate.segment.md) | `packages/api/src/simulate.ts` | Split one request into separate simulation commands. |
| [api/simulate.extract-one.md](api/simulate.extract-one.md) | `packages/api/src/simulate.ts` | Convert one simulation command into structured parameters. |

## Application-specific prompts (`apps/<id>/`)

Each onboarded application owns its own prompts under `apps/<id>/`, kept fully
separate from every other app. They are declared **by path on the app's
`ApplicationDef`** (in its `@log/app-<id>` package), so adding/onboarding an app
never touches another app's prompts. The composition root is
[packages/apps/index.ts](../packages/apps/index.ts); a consistency test
([packages/apps/prompts.consistency.test.ts](../packages/apps/prompts.consistency.test.ts))
asserts every declared path here actually resolves via `loadPrompt`.

| File | Declared by (`ApplicationDef` field) | Role |
|------|--------------------------------------|------|
| `apps/scp/transaction.md`, `apps/apiflc/transaction.md` | `transactionPromptPath` | The **regular ingestion agent**'s transaction lifecycle spec — spawn / advance / close (SCP: REQUEST→ACK→RESPONSE; apiflc: REQUEST→RESPONSE). |
| `apps/scp/validation.agent.md`, `apps/apiflc/validation.agent.md` | `validation.agentPromptPath` | The **validation AI agent**'s spec — the residual reviewer. It is invoked only for transactions the worker passed while `deriveOutcome` could not prove the outcome, may only emit claims that cite real `parsed_logs` ids with re-executable predicates, and is told which checks the worker already enforces so it never restates them. Every claim is re-verified in code before it is recorded. |
| `apps/scp/qa.md`, `apps/apiflc/qa.md` | `assistantPromptPath` | The app's grounded Log-Assistant (scoped Q&A) system prompt. |
| `apps/apiflc/simulate.understand.md` | `simulateUnderstandingPromptPath` | The app's Simulator understanding-agent prompt (extracts its correlation id). |
| `apps/scp/simulate.segment.md`, `apps/scp/simulate.extract-one.md` | (SCP simulator) | SCP simulator segmentation / extraction prompts. |

## How it loads

`loadPrompt('agents/supervisor.md')` resolves this folder by walking up from the
`@log/shared` module (repo root in dev / `node dist`, or beside the bundle in the
Lambda), reads the file, normalizes line endings, and caches it. Set the
`PROMPTS_DIR` env var to override the location.

Because the prompts are read at runtime, this folder is shipped to every runtime
that uses them:

- **API image** — [Dockerfile.api](../Dockerfile.api) copies `prompts/` into the image.
- **Lambda** — [scripts/bundle-lambda.mjs](../scripts/bundle-lambda.mjs) copies `prompts/` next to the esbuild bundle.

Editing a prompt is a content-only change — no code edit required. Keep each file
to the instruction text only (no surrounding backticks or code).
