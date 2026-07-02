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

locals {
  lambda_env = {
    DATABASE_URL          = local.database_url
    # AWS_REGION is auto-set by the Lambda runtime; do not override it here.
    BEDROCK_MODEL_ID      = local.foundation_model
    BEDROCK_EMBED_MODEL_ID = "amazon.titan-embed-text-v2:0"
    CLOUDWATCH_LOG_GROUPS = join(",", var.cloudwatch_log_groups)
    APP_ENDPOINTS_JSON    = var.app_endpoints_json
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

# Allow the Bedrock Agent to invoke the action-group Lambda.
resource "aws_lambda_permission" "bedrock_invoke" {
  statement_id  = "AllowBedrockAgentInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.action_group.function_name
  principal     = "bedrock.amazonaws.com"
  source_arn    = aws_bedrockagent_agent.supervisor.agent_arn
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
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = aws_lambda_function.ingest_poller.arn
    }]
  })
}
