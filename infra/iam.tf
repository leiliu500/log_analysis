data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

# ---------------------------------------------------------------------------
# Lambda execution role (action-group + ingest poller)
# ---------------------------------------------------------------------------
resource "aws_iam_role" "lambda" {
  name = "${local.name}-lambda"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_vpc" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "lambda_inline" {
  name = "${local.name}-lambda-policy"
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "Bedrock"
        Effect   = "Allow"
        Action   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
        Resource = "*"
      },
      # Converse rejects a guardrailConfig the caller is not allowed to apply, so without
      # this every model call in the ingest/validation Lambdas fails once the guardrail is
      # wired in — not silently degrades to unguarded, fails outright.
      {
        Sid      = "ApplyGuardrail"
        Effect   = "Allow"
        Action   = ["bedrock:ApplyGuardrail"]
        Resource = "*"
      },
      {
        Sid      = "ReadLogs"
        Effect   = "Allow"
        Action   = ["logs:FilterLogEvents", "logs:GetLogEvents", "logs:DescribeLogGroups", "logs:DescribeLogStreams", "logs:PutLogEvents", "logs:CreateLogGroup", "logs:CreateLogStream"]
        Resource = "*"
      },
      {
        Sid      = "EmailAndStorage"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:ListBucket", "ses:SendEmail"]
        Resource = "*"
      },
      {
        Sid      = "Secrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = aws_secretsmanager_secret.db.arn
      }
    ]
  })
}

# ---------------------------------------------------------------------------
# Bedrock Agent service role
# ---------------------------------------------------------------------------
resource "aws_iam_role" "bedrock_agent" {
  name = "${local.name}-bedrock-agent"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "bedrock.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id }
      }
    }]
  })
}

resource "aws_iam_role_policy" "bedrock_agent" {
  name = "${local.name}-bedrock-agent-policy"
  role = aws_iam_role.bedrock_agent.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Allow invoking the gov cross-region inference profile AND the
        # foundation models it routes to (both us-gov regions).
        Sid    = "InvokeModel"
        Effect = "Allow"
        Action = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:GetInferenceProfile"]
        Resource = [
          "arn:${data.aws_partition.current.partition}:bedrock:*::foundation-model/*",
          "arn:${data.aws_partition.current.partition}:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/*"
        ]
      },
      {
        Sid      = "InvokeActionLambda"
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = aws_lambda_function.action_group.arn
      },
      # The agent's OWN service role applies the guardrail attached in bedrock.tf — the
      # agent runtime evaluates it, not the caller. Missing this makes an agent with a
      # guardrail_configuration fail on every turn.
      #
      # Guarded resource, unlike the app roles': there is exactly one guardrail an agent
      # should ever apply, and an agent that could apply an arbitrary one could apply an
      # empty one. Falls back to "*" only when the guardrail is disabled, where the
      # statement grants nothing that is reachable anyway.
      {
        Sid      = "ApplyGuardrail"
        Effect   = "Allow"
        Action   = ["bedrock:ApplyGuardrail"]
        Resource = var.guardrail_enabled ? local.guardrail_arn : "*"
      },
      {
        # Supervisor router must be able to reach its collaborator agent aliases.
        Sid    = "CollaborateWithAgents"
        Effect = "Allow"
        Action = ["bedrock:InvokeAgent", "bedrock:GetAgentAlias", "bedrock:GetAgent"]
        Resource = [
          "arn:${data.aws_partition.current.partition}:bedrock:*:${data.aws_caller_identity.current.account_id}:agent/*",
          "arn:${data.aws_partition.current.partition}:bedrock:*:${data.aws_caller_identity.current.account_id}:agent-alias/*"
        ]
      }
    ]
  })
}

# ---------------------------------------------------------------------------
# ECS task + execution roles
# ---------------------------------------------------------------------------
resource "aws_iam_role" "ecs_execution" {
  name = "${local.name}-ecs-exec"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "ecs_execution_secrets" {
  name = "${local.name}-ecs-exec-secrets"
  role = aws_iam_role.ecs_execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = aws_secretsmanager_secret.db.arn
    }]
  })
}

resource "aws_iam_role" "ecs_task" {
  name = "${local.name}-ecs-task"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "ecs_task" {
  name = "${local.name}-ecs-task-policy"
  role = aws_iam_role.ecs_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      {
        Effect   = "Allow"
        Action   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:InvokeAgent"]
        Resource = "*"
      },
      {
        Sid      = "ApplyGuardrail"
        Effect   = "Allow"
        Action   = ["bedrock:ApplyGuardrail"]
        Resource = "*"
      },
      # Makes the guardrail NON-BYPASSABLE for the API task: a Converse call that omits it
      # is denied at the IAM layer, so protection no longer depends on the application
      # remembering to attach it (or on nobody shipping a code path that forgets).
      #
      # Off by default — see guardrail_enforce_iam in variables.tf for why enabling it in
      # the same apply that creates the guardrail would take every AI stage offline.
      # Scoped to the text foundation model so Titan embedding calls, which legitimately
      # carry no guardrail, are unaffected.
      ], var.guardrail_enforce_iam && var.guardrail_enabled ? [{
        Sid      = "DenyUnguardedModelInvoke"
        Effect   = "Deny"
        Action   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
        Resource = "arn:${data.aws_partition.current.partition}:bedrock:*::foundation-model/${local.foundation_model}"
        Condition = {
          StringNotEquals = { "bedrock:GuardrailIdentifier" = "${local.guardrail_arn}:${local.guardrail_version}" }
        }
      }] : [], [
      {
        Effect   = "Allow"
        Action   = ["logs:FilterLogEvents", "logs:GetLogEvents", "logs:PutLogEvents", "logs:CreateLogStream", "logs:CreateLogGroup", "logs:DescribeLogStreams", "logs:DescribeLogGroups"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:ListBucket", "ses:SendEmail"]
        Resource = "*"
      }
    ])
  })
}
