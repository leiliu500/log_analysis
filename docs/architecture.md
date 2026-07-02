# Architecture

## 1. Design goals

- **Source-agnostic ingestion.** New log sources are a new `LogConnector`; the
  analysis pipeline never changes.
- **Deterministic core, LLM at the edges.** Parsing, fingerprinting, entity
  extraction, baselines/anomaly scoring, and correlation are pure, fast, and
  testable. Bedrock is called only for the expensive/ambiguous steps: reasoning
  over a correlated cluster, embeddings, supervisor routing, and simulation.
- **Everything is a Finding.** Anomalies, correlations, inferences, reasoning,
  and learned patterns are one persisted shape (`Finding`) with evidence,
  reasoning steps, and recommendations. The dashboard and chatbot read one model.
- **Scoped retrieval.** The chatbot answers only from findings/logs semantically
  related to the question (pgvector cosine search), never global aggregates.

## 2. Data flow

```
RawLogRecord ──parse──► ParsedLog ──embed?──► persist
                           │
                           ├─ scoreAndLearn ─► AnomalyScore (updates EWMA baselines)
                           └─ correlate ─────► Cluster (shared entity / cross-source)
                                                  │
                                        reasonAboutCluster (Bedrock)
                                                  │
                                                Finding ─► persist ─► Alert (high/critical)
```

Two entry points drive this pipeline:

1. **Scheduled** — EventBridge invokes `ingestPollerHandler` every 5 minutes; it
   pulls a window from every connector and runs `runPipeline`.
2. **On-demand** — `POST /analyze` or the `analyze_logs` chat intent.

## 3. Components

### shared
Zod schemas are the single source of truth for every cross-package type
(`ParsedLog`, `Finding`, `RouteDecision`, `ChatRequest`, `SimulateRequest`, …).
Schemas double as runtime validators at API and agent boundaries.

### analysis
- `parser.ts` — JSON / logfmt / freeform detection → `ParsedLog`.
- `extract.ts` — level detection, entity + numeric-field extraction.
- `fingerprint.ts` — Drain-like template masking → stable signature.
- `learn.ts` — per-fingerprint EWMA rate + variance baselines persisted to
  `learned_patterns`; z-score + new-burst gating. **This is the learning loop.**
- `correlate.ts` — groups logs by shared strong entities within a window;
  prefers cross-source clusters.
- `reason.ts` — Bedrock Converse turns a cluster into a `Finding` with a
  reasoning trace, then embeds it for retrieval.
- `bedrock.ts` — Converse + Titan embeddings wrapper (`converse`,
  `converseJson`, `embed`).

### ingestion
`LogConnector` = `{ source, pull(), write?() }`. CloudWatch, Splunk (REST +
HEC), Grafana Loki (query_range + push), and Email (SES→S3 inbound + SES send).
`write()` is what the simulator uses to inject logs.

### agents
- `supervisor.ts` — local Bedrock-Converse router mirroring the native agent's
  instructions (fast path for the API; testable without provisioning).
- `appInvoker.ts` — calls a real downstream endpoint from `APP_ENDPOINTS_JSON`.
- `actionGroup.ts` — one Lambda handler backing all agent tools, dispatched by
  `apiPath` (`/findings/search`, `/logs/analyze`, `/simulate`, `/invoke-app`).
- `ingestPoller.ts` — scheduled ingestion Lambda.
- `invokeAgent.ts` — streams answers from the provisioned native supervisor.

### api
Fastify. `/chat` is the orchestrator: persist message → `routeRequest` →
dispatch by intent (query / analyze / simulate / invoke-app) → for queries,
retrieve scoped findings+logs and answer grounded in them.

### web
Next.js App Router (React 19, Tailwind). Dashboard (severity tiles + finding
cards with expandable reasoning), a Claude-style chat that shows what each
answer was grounded in, and a simulator form.

## 4. Scaling to large log volume (requirement 4)

- **Batching & windows.** Logs are processed per source, per time window;
  connectors page through results (`nextToken`, `limit`).
- **Cheap-first funnel.** Only clusters that are anomalous or cross-source reach
  the LLM (`maxReasoned` cap), so Bedrock cost scales with *interesting* events,
  not raw volume.
- **Fingerprint collapse.** Structurally identical logs share a fingerprint, so
  a 100k-line error storm is one baseline update + one finding, not 100k calls.
- **Stateless workers.** `runPipeline` is stateless; scale horizontally by
  fanning windows/sources across Lambda invocations or ECS tasks. State lives in
  Postgres (baselines, findings) and is safe to write concurrently.
- **Optional log embeddings.** `embedLogs` is off by default; enable per-source
  when you want log-level semantic search, on by default for findings only.
- **Next steps for very high volume:** put Kinesis/Firehose or SQS in front of
  the poller, and move `parsed_logs` to partitioned tables or a time-series
  store, keeping `findings` in Postgres.

## 5. Data model

`parsed_logs`, `findings`, `alerts`, `chat_sessions`, `chat_messages`,
`learned_patterns` — see [packages/db/migrations/0000_init.sql](../packages/db/migrations/0000_init.sql).
`findings.embedding` and `parsed_logs.embedding` are `vector(1024)` (Titan v2)
with an ivfflat cosine index powering scoped retrieval.

## 6. Bedrock agent topology (requirements 1 & 11)

`infra/bedrock.tf` provisions a **supervisor** agent (`SUPERVISOR_ROUTER`) with
three **collaborators** (analysis / simulator / app-invoker), each holding an
action group bound to the same TypeScript Lambda via an OpenAPI schema
(`infra/schemas/actions.openapi.json`). `infra/flow.tf` provisions a Bedrock
**Flow** (Input → Supervisor Agent → Output). The API can either use the native
agent (`invokeSupervisorAgent`) or the local router (`routeRequest`).

## 7. Deployment (requirement 12)

Terraform stands up: VPC (public/private subnets, NAT, SGs), RDS Postgres 16
(Multi-AZ, encrypted, Secrets Manager creds), the action-group + ingest Lambdas
(VPC-attached) with an EventBridge schedule, ECR + ECS Fargate services for API
and web behind an ALB, and all IAM roles. Container images are built from
`Dockerfile.api` / `Dockerfile.web` and pushed to the ECR repos in the outputs.

### GovCloud note
`variables.tf` currently defaults `region` to `us-gov-west-1`. **Amazon Bedrock
availability and the set of enabled foundation models differ in AWS GovCloud** —
confirm the Claude/Titan model IDs and ARNs available in your partition and
update `bedrock_model_arn`, `BEDROCK_MODEL_ID`, and `BEDROCK_EMBED_MODEL_ID`
accordingly. Bedrock Agents/Flows resources may also lag in some partitions; if
so, run the analysis pipeline + local `routeRequest` path (both fully functional
without native agents) and adopt native agents where supported.

## 8. Known TODOs / hardening before production

- Source auth (Splunk/Grafana tokens, IMAP) is env-driven; wire to Secrets Manager.
- Add alert delivery channels (SNS/SES/webhook) off the `alerts` table.
- Add authn/z (Cognito/OIDC) in front of the API + web ALB.
- Add HTTPS listener + ACM cert on the ALB.
- Tune ivfflat `lists` and add `ANALYZE`/reindex jobs as data grows.
- Rate-limit and cost-cap Bedrock calls; add retries/backoff and a dead-letter path.
