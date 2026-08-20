# The Lambda bundle is produced by `npm run bundle:lambda` at the repo root,
# which esbuilds packages/agents handlers into infra/build/lambda/index.js.
data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = "${path.module}/build/lambda"
  output_path = "${path.module}/build/lambda.zip"
}

resource "aws_cloudwatch_log_group" "action_group" {
  name              = "/aws/lambda/${local.name}-action-group"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "ingest" {
  name              = "/aws/lambda/${local.name}-ingest"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "validation" {
  name              = "/aws/lambda/${local.name}-validation"
  retention_in_days = 30
}

locals {
  lambda_env = {
    DATABASE_URL = local.database_url
    # AWS_REGION is auto-set by the Lambda runtime; do not override it here.
    BEDROCK_MODEL_ID       = local.foundation_model
    BEDROCK_EMBED_MODEL_ID = "amazon.titan-embed-text-v2:0"
    # The output-token ceiling EVERY agent inherits (ingestion reasoner, validation AI
    # agent, analysis reasoning, simulator, Log Assistant). It is a cap, not a
    # reservation — cost and latency follow the tokens actually emitted — so it is set
    # generously. A tight ceiling is the failure mode that bites: the reasoning model
    # spends hidden tokens from this same budget and the visible reply arrives truncated.
    BEDROCK_MAX_TOKENS = tostring(var.bedrock_max_tokens)
    # Guardrail applied to every Converse call these Lambdas make (ingest transitions,
    # validation review, analysis reasoning). Empty when guardrail_enabled = false, which
    # the runtime reads as "no guardrail" and sends the original unguarded request — so
    # switching it off never leaves the app pointing at an identifier that no longer
    # resolves, which would fail every call rather than degrade.
    BEDROCK_GUARDRAIL_ID      = local.guardrail_id
    BEDROCK_GUARDRAIL_VERSION = local.guardrail_version
    CLOUDWATCH_LOG_GROUPS     = join(",", concat(var.cloudwatch_log_groups, var.application_log_groups))
    APP_ENDPOINTS_JSON        = var.app_endpoints_json
    # System-of-record reconciliation endpoints for the validation worker. Empty by
    # default ⇒ reconciliation is disabled (returns 'unknown', never affects a verdict).
    # Set these to activate the cross-check against the downstream ledger / Data Services.
    SCP_RECONCILE_URL      = var.scp_reconcile_url
    SCP_RECONCILE_TOKEN    = var.scp_reconcile_token
    APIFLC_RECONCILE_URL   = var.apiflc_reconcile_url
    APIFLC_RECONCILE_TOKEN = var.apiflc_reconcile_token
    # Per-application VALIDATION AI AGENT (the residual reviewer). Set explicitly rather
    # than relying on the code default so it can be switched off, or its cost re-bounded,
    # without a code deploy. It only ever sees transactions the deterministic worker
    # passed without proving the outcome, and its claims are re-verified in code before
    # being recorded, so it can never overturn a deterministic verdict.
    VALIDATION_AI_ENABLED      = tostring(var.validation_ai_enabled)
    VALIDATION_AI_MAX_PER_POLL = tostring(var.validation_ai_max_per_poll)
    # Wall-clock budget for the whole AI stage, kept well under the validation Lambda's
    # timeout below: deterministic results are persisted AFTER the stage, so the stage
    # must never be able to run the Lambda out of time.
    VALIDATION_AI_DEADLINE_MS = tostring(var.validation_ai_deadline_ms)
    # Bump when an app's validation.agent.md changes: reviews older than this epoch are
    # redone, so a false positive corrected in the prompt is actually cleared off the
    # board instead of being frozen there by the one-shot dedup.
    VALIDATION_AI_REVIEW_EPOCH = tostring(var.validation_ai_review_epoch)
  }
}

resource "aws_lambda_function" "action_group" {
  function_name    = "${local.name}-action-group"
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs20.x"
  handler          = "index.actionGroupHandler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  timeout          = 120
  memory_size      = 1024

  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.lambda.id]
  }
  environment { variables = local.lambda_env }
  depends_on = [aws_cloudwatch_log_group.action_group]
}

resource "aws_lambda_function" "ingest_poller" {
  function_name    = "${local.name}-ingest"
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs20.x"
  handler          = "index.ingestPollerHandler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  timeout          = 300
  memory_size      = 1536

  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.lambda.id]
  }
  environment { variables = local.lambda_env }
  depends_on = [aws_cloudwatch_log_group.ingest]
}

# Autonomous validation poller. Runs on its OWN schedule, fully decoupled from the
# ingest poller: it only reads the agents + findings tables and writes the
# validation_agents table, so it can never mutate or block the ingestion path.
resource "aws_lambda_function" "validation_poller" {
  function_name    = "${local.name}-validation"
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs20.x"
  handler          = "index.validationPollerHandler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  # Deterministic validation is fast; the headroom is for the residual AI stage, which is
  # itself bounded by VALIDATION_AI_DEADLINE_MS so the deterministic upsert always runs.
  timeout     = 300
  memory_size = 1024

  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.lambda.id]
  }
  environment { variables = local.lambda_env }
  depends_on = [aws_cloudwatch_log_group.validation]
}

# Allow the Bedrock Agent to invoke the action-group Lambda.
# Allow the supervisor AND every collaborator agent to invoke the action-group
# Lambda. Each collaborator's action group calls this Lambda under its own agent
# ARN, so a supervisor-only permission denied them ("Access denied while
# invoking Lambda"). Scope to all Bedrock agents in this account.
resource "aws_lambda_permission" "bedrock_invoke" {
  statement_id  = "AllowBedrockAgentInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.action_group.function_name
  principal     = "bedrock.amazonaws.com"
  source_arn    = "arn:${data.aws_partition.current.partition}:bedrock:${var.region}:${data.aws_caller_identity.current.account_id}:agent/*"
}

# Scheduled ingestion every 5 minutes (always-on analysis pipeline).
resource "aws_scheduler_schedule" "ingest" {
  name       = "${local.name}-ingest-schedule"
  group_name = "default"
  flexible_time_window { mode = "OFF" }
  schedule_expression = "rate(5 minutes)"
  target {
    arn      = aws_lambda_function.ingest_poller.arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ windowMinutes = 5 })
  }
}

# Autonomous validation every 5 minutes, running in parallel with (and independent
# of) ingestion. Offset so it observes state the ingest poller has committed.
resource "aws_scheduler_schedule" "validation" {
  name       = "${local.name}-validation-schedule"
  group_name = "default"
  flexible_time_window { mode = "OFF" }
  schedule_expression = "rate(5 minutes)"
  target {
    arn      = aws_lambda_function.validation_poller.arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({})
  }
}

resource "aws_iam_role" "scheduler" {
  name = "${local.name}-scheduler"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "scheduler" {
  name = "${local.name}-scheduler-policy"
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["lambda:InvokeFunction"]
      Resource = [
        aws_lambda_function.ingest_poller.arn,
        aws_lambda_function.validation_poller.arn,
      ]
    }]
  })
}
