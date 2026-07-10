# LogIntel — AWS Bedrock Agentic Log-Analysis Platform

A production-oriented, TypeScript monorepo that ingests logs from many sources,
runs Bedrock-powered agents to parse / correlate / reason / learn, stores
findings and anomalies in Postgres, and exposes a dashboard plus a scoped
ChatGPT/Claude-style assistant. Includes a simulator agent and Terraform to
deploy the whole thing to AWS.

```
                 ┌─────────────────────────── Bedrock Agents ───────────────────────────┐
                 │  Supervisor (SUPERVISOR_ROUTER)                                       │
 user request →  │    ├── analysis-agent      (searchFindings / analyzeLogs)            │
 (chat / flow)   │    ├── simulator-agent     (simulateLogs)                            │
                 │    └── scp-agent          (invokeApplication → e.g. scp)            │
                 └───────────────┬──────────────────────────────────────────────────────┘
                                 │ Action Group Lambda (TypeScript, dispatch by apiPath)
        ┌────────────────────────┼───────────────────────────────────────────┐
        ▼                        ▼                                            ▼
  Ingestion connectors     Analysis engine                              Simulator
  cloudwatch / splunk  →   parse → extract → fingerprint → learn   →    generate + write
  grafana / email          → correlate → reason (Bedrock) → Finding      logs to sinks
        │                        │
        │                        ▼
        │                  Postgres (+ pgvector)  ── findings, anomalies, logs, chat, baselines
        │                        │
        ▼                        ▼
  EventBridge (5-min)      Fastify API  ──  Next.js dashboard + scoped chatbot
  scheduled ingest              /findings /chat /simulate /invoke-app /analyze
```

## Requirement → implementation map

| # | Requirement | Where |
|---|-------------|-------|
| 1 | Bedrock agents **and flow** | [infra/bedrock.tf](infra/bedrock.tf), [infra/flow.tf](infra/flow.tf) |
| 2 | All log sources + agents (CloudWatch, Splunk, Email, Grafana, …) | [packages/ingestion/src](packages/ingestion/src) |
| 3 | Parse, extract, correlate, infer, reason, learn | [packages/analysis/src](packages/analysis/src) |
| 4 | Scale to large log content | batched pipeline + windowed baselines: [pipeline.ts](packages/analysis/src/pipeline.ts), scheduled Lambda [ingestPoller.ts](packages/agents/src/ingestPoller.ts) |
| 5 | Report/alert anomalies → Postgres | [packages/db](packages/db), alerts in [pipeline.ts](packages/analysis/src/pipeline.ts) |
| 6 | Dashboard for findings/anomalies/reasoning | [web/app/page.tsx](web/app/page.tsx) |
| 7 | Chatbot, **scoped** (not global) findings | [packages/api/src/chat.ts](packages/api/src/chat.ts), [web/app/chat](web/app/chat) |
| 8 | Simulator agent writes to all sinks | [packages/simulator/src/simulator.ts](packages/simulator/src/simulator.ts) |
| 9 | Chatbot triggers simulator w/ sample req/resp | intent `simulate_logs` in [chat.ts](packages/api/src/chat.ts), UI [web/app/simulate](web/app/simulate) |
| 10 | Chatbot triggers real app endpoint | intent `invoke_application` → [invokeApplication.ts](packages/apps/scp/src/invokeApplication.ts) |
| 11 | Supervisor parses/extracts/routes to collaborator/app (e.g. scp) | [supervisor.ts](packages/agents/src/supervisor.ts) + [infra/bedrock.tf](infra/bedrock.tf) |
| 12 | Terraform to deploy to AWS | [infra/](infra) |
| 13 | TypeScript | entire codebase |

## Monorepo layout

```
packages/
  shared/      domain types + zod schemas (source of truth)
  db/          Postgres schema, migrations, typed queries (Drizzle + pgvector)
  analysis/    parse/extract/fingerprint/learn/correlate/reason + Bedrock wrapper
  ingestion/   LogConnector for cloudwatch | splunk | grafana | email
  agents/      supervisor routing, app invoker, Bedrock action-group + poller Lambdas
  simulator/   simulator agent (generate + write logs)
  api/         Fastify API (findings, logs, chat, simulate, invoke-app, analyze)
  apps/scp/    SCP application: its log groups + downstream-app invoker (@log/app-scp)
web/           Next.js dashboard + scoped chatbot + simulator UI
prompts/       externalized LLM system prompts (.md), loaded via loadPrompt()
infra/         Terraform: VPC, RDS, Bedrock agents/flow, Lambda, ECS/ALB, IAM
scripts/       Lambda bundler
```

## Run locally

Prerequisites: Node 20+, Docker, and AWS credentials with Bedrock model access
(`anthropic.claude-*` + `amazon.titan-embed-text-v2`).

```bash
cp .env.example .env            # fill in AWS + source creds
npm install
npm run db:up                   # Postgres w/ pgvector via docker compose
npm run db:migrate
npm run db:seed                 # demo finding so the dashboard isn't empty

npm run dev:api                 # http://localhost:4000
npm run dev:web                 # http://localhost:3000

# Generate logs, then analyze them:
npm run simulate -- --app scp --sinks cloudwatch --count 100 --anomalies true
curl -XPOST localhost:4000/analyze -H 'content-type: application/json' \
  -d '{"source":"cloudwatch"}'
```

The analysis engine calls Bedrock; without AWS credentials the parse/learn/
correlate stages still run, but reasoning (Finding generation) and embeddings
degrade gracefully.

## Deploy to AWS

```bash
npm run bundle:lambda           # produces infra/build/lambda/index.js
cd infra
cp terraform.tfvars.example terraform.tfvars   # set model ARN, endpoints, etc.
terraform init
terraform apply
```

Then build & push the API/web images to the ECR repos in the Terraform outputs,
run `npm run db:migrate` against the RDS endpoint, and the ALB DNS name serves
the dashboard. `supervisor_agent_id` / `_alias_id` outputs wire the API to the
native Bedrock agent.

See [docs/architecture.md](docs/architecture.md) for the deeper design, the data
model, scaling strategy, and the GovCloud/Bedrock availability note.

## Status

`npm install`, `tsc -b` (all backend workspaces), the web `tsc --noEmit`, the
analysis unit tests, and `npm run bundle:lambda` all pass. Business logic is
real and wired end-to-end; a few edges are marked with TODOs where they need
your environment-specific values (source auth, endpoints, model IDs).
