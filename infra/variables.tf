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
    Current value set 2026-07-30, when the SCP/apiflc agent prompts gained their
    by-design "never claim these" lists after four false positives in prod.
  EOT
  type        = number
  default     = 1785376800000
}

variable "validation_ai_deadline_ms" {
  description = "Wall-clock budget for the whole validation AI stage. Must stay well under the validation Lambda timeout, since deterministic results are persisted after the stage."
  type        = number
  default     = 60000
}
