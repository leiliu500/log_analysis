variable "project" {
  type    = string
  default = "log-analysis"
}

variable "environment" {
  type    = string
  default = "prod"
}

variable "region" {
  type    = string
  default = "us-gov-west-1"
}

variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}

variable "az_count" {
  type    = number
  default = 2
}

variable "bedrock_max_tokens" {
  description = <<-EOT
    Output-token ceiling every agent inherits (ingestion reasoner, validation AI agent,
    analysis reasoning, simulator, Log Assistant). A CAP, not a reservation: cost and
    latency follow the tokens actually emitted, so a generous value is free on short
    replies. Set generously on purpose — the configured reasoning model charges its
    hidden reasoning tokens against this same budget, so a tight ceiling gets eaten by
    reasoning and the visible reply arrives truncated or empty. Verified: the deployed
    model accepts ceilings up to its full context window. Individual call sites can still
    bound themselves (INGEST_DYNAMIC_MAXTOKENS, VALIDATION_AI_MAXTOKENS).
  EOT
  type        = number
  default     = 32000
}

variable "bedrock_model_arn" {
  description = "Foundation model ARN the agents use (Claude on Bedrock)."
  type        = string
  default     = "openai.gpt-oss-120b-1:0"
}

# --- Bedrock Guardrail (model-call safety policy) -----------------------------
# See guardrail.tf for why the policy is shaped the way it is. These knobs exist so the
# protection can be re-tuned or switched off from Terraform without a code deploy — the
# runtime reads BEDROCK_GUARDRAIL_ID and treats an empty value as "no guardrail".

variable "guardrail_enabled" {
  description = <<-EOT
    Create the guardrail and apply it to every model call and hosted agent. false =
    destroy it and clear the env vars, restoring exactly the pre-guardrail request shape.
    The escape hatch for the failure mode that matters: a policy blocking legitimate
    incident analysis must be reversible in one apply, without waiting on a code change.
  EOT
  type        = bool
  default     = true
}

variable "guardrail_revision" {
  description = <<-EOT
    Bump to cut a NEW numbered guardrail version from the current policy. Terraform cannot
    see that the policy body changed underneath an existing version, so edits to
    guardrail.tf do NOT reach production until this is incremented — the same deliberate
    gate the Bedrock flow uses (flow_revision).
  EOT
  type        = number
  default     = 1
}

variable "guardrail_masked_pii" {
  description = <<-EOT
    Bedrock managed PII types anonymized out of model replies.

    Deliberately NARROW, and widening it is not free. This platform's job is to reproduce
    transaction payloads verbatim and cite real message ids, so masking domain identifiers
    breaks the product in a way that still looks healthy: the answer arrives, with the
    number the user asked for replaced by a placeholder. Types like US_BANK_ACCOUNT_NUMBER
    and EMAIL are therefore NOT masked by default — for an SCP/apiflc settlement corpus
    those are the payload, not a leak.

    The default set is the content that is always a credential and never an answer.
  EOT
  type        = list(string)
  default = [
    "AWS_ACCESS_KEY",
    "AWS_SECRET_KEY",
    "PASSWORD",
    "CREDIT_DEBIT_CARD_NUMBER",
    "CREDIT_DEBIT_CARD_CVV",
    "PIN",
  ]
}

variable "guardrail_enforce_iam" {
  description = <<-EOT
    Add an IAM Deny so InvokeModel on the text foundation model FAILS unless it carries
    this guardrail — making the protection non-bypassable rather than dependent on the
    application remembering to attach it.

    Default false ON PURPOSE, because of this platform's deploy topology: application code
    ships as a CodeBuild container image, separately from terraform apply. Enabling this in
    the same apply that creates the guardrail would deny every model call made by the
    already-running image, which does not yet read BEDROCK_GUARDRAIL_ID — a self-inflicted
    outage of every AI stage.

    Correct sequence: apply with this false, rebuild and deploy the images, confirm
    guardrail activity is showing up in model-call telemetry, then set this true.

    Scoped to the text model only; the Titan embedding model is excluded because embedding
    calls pass no guardrail and would otherwise be denied along with it.
  EOT
  type        = bool
  default     = false
}

variable "db_username" {
  type    = string
  default = "loguser"
}

variable "db_name" {
  type    = string
  default = "loganalysis"
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}

variable "api_image" {
  description = "ECR image URI for the API service (built + pushed via CI)."
  type        = string
  default     = ""
}

variable "web_image" {
  description = "ECR image URI for the web dashboard."
  type        = string
  default     = ""
}

variable "cloudwatch_log_groups" {
  # Entries may use a "*" suffix as a prefix wildcard, expanded via
  # DescribeLogGroups. "/sim/*" covers all simulated-application log groups.
  type    = list(string)
  default = ["/sim/*"]
}

variable "application_log_groups" {
  # Fixed, named CloudWatch log groups created by Terraform for the onboarded
  # applications. The simulator writes to these (by target log group or content
  # type) and the ingestion pipeline reads from them.
  type = list(string)
  default = [
    # SCP / ESB
    "adt-d2-scp-log-group",
    "adt-d2-scp-restapp-log-group",
    "esb-cloudwatch-logs-agent-cash",
    # apiflc (Lambda handlers + API Gateway execution logs)
    "/aws/lambda/adt-fca-d1-api_gateway_handler",
    "/aws/lambda/adt-fca-d1-api_gateway_authorizer",
    "/aws/lambda/adt-fca-d1-api_gateway_background",
    "API-Gateway-Execution-Logs_9ioz6z9om1/d1",
  ]
}

variable "app_endpoints_json" {
  description = "JSON map of appName -> real endpoint for the scp-agent."
  type        = string
  default     = "{\"scp\":\"https://scp.example.internal/api/execute\"}"
}

# ---- System-of-record reconciliation (validation worker) ----
# Empty ⇒ reconciliation disabled (the hook returns 'unknown' and never affects a
# verdict). Set to the downstream ledger / Data Services status API to activate.
variable "scp_reconcile_url" {
  description = "Base URL of the SCP settlement / system-of-record status API. Empty = disabled."
  type        = string
  default     = ""
}
variable "scp_reconcile_token" {
  description = "Optional bearer token for the SCP reconciliation API."
  type        = string
  default     = ""
  sensitive   = true
}
variable "apiflc_reconcile_url" {
  description = "Base URL of the apiflc Data Services system-of-record status API. Empty = disabled."
  type        = string
  default     = ""
}
variable "apiflc_reconcile_token" {
  description = "Optional bearer token for the apiflc reconciliation API."
  type        = string
  default     = ""
  sensitive   = true
}

variable "flow_revision" {
  description = "Bump to force the Bedrock flow to re-prepare, re-version, and re-point its alias."
  type        = number
  default     = 1
}

# --- Validation AI agent (the per-application residual reviewer) --------------
# The only model in the validation path. It is invoked ONLY for transactions the
# deterministic worker passed while the logs never proved the outcome, and every claim
# it makes is re-executed against the real log rows before being recorded — so it can
# add a suspicion to the unproven set but can never overturn a proven verdict. These
# knobs exist so the stage can be switched off or re-bounded without a code deploy.

variable "validation_ai_enabled" {
  description = "Run each application's validation AI agent over the residual set. false = deterministic validation only."
  type        = bool
  default     = true
}

variable "validation_ai_max_per_poll" {
  description = "Hard cap on validation AI model calls per poll. Bounds cost; a truncated run is logged, never silent."
  type        = number
  default     = 10
}

variable "validation_ai_review_epoch" {
  description = <<-EOT
    Epoch milliseconds. AI reviews recorded BEFORE this instant no longer count as done,
    so those transactions are reviewed again. Bump it (to `date +%s000`) whenever an
    app's validation.agent.md changes — a claim is only as good as the spec that produced
    it, and without this the one-shot dedup would freeze verdicts from a superseded
    prompt on the board permanently. 0 = never re-review.
    History of bumps, each one a correction that had to supersede earlier verdicts:
      02:00Z - by-design lists added; cleared the messageId / sender / authorizer FPs.
      03:25Z - "same message on two log lines is re-logging, not a duplicate".
      03:39Z - gate rejects absence-only claims (predicates that are all
               `not_contains`), which is what let "lacks a terminal status line" and
               "sendTime missing seconds" through as verified findings.
      04:27Z - residual narrowed to COMPLETED transactions only (a failed/timed-out one
               was already flagged, so it is not part of the false-negative population),
               and the gate now rejects vacuous membership-only witnesses.
      07-31  - gate rejects REPEATED predicates (paired co-occurrence) and both
               prompts ban log-pipeline claims, after all 5 admitted claims in a
               50-transaction run were duplicate-logging or timestamp-format noise.
  EOT
  type        = number
  default     = 1785510435000
}

variable "validation_ai_deadline_ms" {
  description = "Wall-clock budget for the whole validation AI stage. Must stay well under the validation Lambda timeout, since deterministic results are persisted after the stage."
  type        = number
  default     = 60000
}
