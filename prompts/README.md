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
