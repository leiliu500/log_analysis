# ---------------------------------------------------------------------------
# Native Bedrock Agents + Flow (requirements 1 & 11)
#
# Topology:
#   supervisor (SUPERVISOR_ROUTER) --routes--> collaborator agents
#     - analysis-agent      : query findings / analyze logs
#     - simulator-agent     : generate simulated logs
#     - app-invoker-agent   : call real application endpoints (e.g. scp)
#   All collaborators share one action-group Lambda, dispatched by apiPath.
# ---------------------------------------------------------------------------

locals {
  # Agent + reasoning foundation model, driven by var.bedrock_model_arn
  # (default "openai.gpt-oss-120b-1:0" — the model this account's existing
  # agents already use successfully). A plain model id, as GovCloud expects.
  foundation_model = var.bedrock_model_arn
}

# ---------------- Collaborator: analysis-agent ----------------
resource "aws_bedrockagent_agent" "analysis" {
  agent_name              = "${local.name}-analysis-agent"
  agent_resource_role_arn = aws_iam_role.bedrock_agent.arn
  foundation_model        = local.foundation_model
  idle_session_ttl_in_seconds = 1800
  instruction             = <<-EOT
    You analyze logs and answer questions using ONLY stored findings/logs
    retrieved via the searchFindings and analyzeLogs tools. Never invent data.
    Scope answers to what the user asked about; cite findings by title and logs
    by timestamp/source.
  EOT
}

resource "aws_bedrockagent_agent_action_group" "analysis_actions" {
  agent_id          = aws_bedrockagent_agent.analysis.agent_id
  agent_version     = "DRAFT"
  action_group_name = "log-tools"
  action_group_executor {
    lambda = aws_lambda_function.action_group.arn
  }
  api_schema {
    payload = file("${path.module}/schemas/actions.openapi.json")
  }
}

resource "aws_bedrockagent_agent_alias" "analysis" {
  agent_id         = aws_bedrockagent_agent.analysis.agent_id
  agent_alias_name = "live"
  depends_on       = [aws_bedrockagent_agent_action_group.analysis_actions]
}

# ---------------- Collaborator: simulator-agent ----------------
resource "aws_bedrockagent_agent" "simulator" {
  agent_name              = "${local.name}-simulator-agent"
  agent_resource_role_arn = aws_iam_role.bedrock_agent.arn
  foundation_model        = local.foundation_model
  instruction             = <<-EOT
    You simulate application logs. Given an application and a sample
    request/response, call simulateLogs to generate and write logs to the
    requested sinks. Confirm counts written per sink.
  EOT
}

resource "aws_bedrockagent_agent_action_group" "simulator_actions" {
  agent_id          = aws_bedrockagent_agent.simulator.agent_id
  agent_version     = "DRAFT"
  action_group_name = "log-tools"
  action_group_executor { lambda = aws_lambda_function.action_group.arn }
  api_schema { payload = file("${path.module}/schemas/actions.openapi.json") }
}

resource "aws_bedrockagent_agent_alias" "simulator" {
  agent_id         = aws_bedrockagent_agent.simulator.agent_id
  agent_alias_name = "live"
  depends_on       = [aws_bedrockagent_agent_action_group.simulator_actions]
}

# ---------------- Collaborator: app-invoker-agent ----------------
resource "aws_bedrockagent_agent" "app_invoker" {
  agent_name              = "${local.name}-app-invoker-agent"
  agent_resource_role_arn = aws_iam_role.bedrock_agent.arn
  foundation_model        = local.foundation_model
  instruction             = <<-EOT
    You invoke real downstream applications (e.g. scp) using the invokeApplication
    tool with the user's request payload. Summarize status and response.
  EOT
}

resource "aws_bedrockagent_agent_action_group" "app_invoker_actions" {
  agent_id          = aws_bedrockagent_agent.app_invoker.agent_id
  agent_version     = "DRAFT"
  action_group_name = "log-tools"
  action_group_executor { lambda = aws_lambda_function.action_group.arn }
  api_schema { payload = file("${path.module}/schemas/actions.openapi.json") }
}

resource "aws_bedrockagent_agent_alias" "app_invoker" {
  agent_id         = aws_bedrockagent_agent.app_invoker.agent_id
  agent_alias_name = "live"
  depends_on       = [aws_bedrockagent_agent_action_group.app_invoker_actions]
}

# ---------------- Supervisor (router) ----------------
resource "aws_bedrockagent_agent" "supervisor" {
  agent_name                  = "${local.name}-supervisor"
  agent_resource_role_arn     = aws_iam_role.bedrock_agent.arn
  foundation_model            = local.foundation_model
  agent_collaboration         = "SUPERVISOR_ROUTER"
  idle_session_ttl_in_seconds = 1800
  prepare_agent               = true
  instruction                 = <<-EOT
    You are the Supervisor. Parse and extract intent from the user request and
    route to exactly one collaborator:
      - analysis-agent   for questions about logs/findings or on-demand analysis
      - simulator-agent  to generate/simulate logs
      - app-invoker-agent to call a real application endpoint (e.g. scp)
    Do not answer directly; delegate. Pass through the user's parameters.
  EOT
}

resource "aws_bedrockagent_agent_collaborator" "analysis" {
  agent_id                   = aws_bedrockagent_agent.supervisor.agent_id
  agent_version              = "DRAFT"
  collaborator_name          = "analysis-agent"
  collaboration_instruction  = "Delegate questions about logs, findings, anomalies, or on-demand analysis."
  relay_conversation_history = "TO_COLLABORATOR"
  agent_descriptor {
    alias_arn = aws_bedrockagent_agent_alias.analysis.agent_alias_arn
  }
}

resource "aws_bedrockagent_agent_collaborator" "simulator" {
  agent_id                  = aws_bedrockagent_agent.supervisor.agent_id
  agent_version             = "DRAFT"
  collaborator_name         = "simulator-agent"
  collaboration_instruction = "Delegate requests to simulate or generate logs for an application."
  agent_descriptor {
    alias_arn = aws_bedrockagent_agent_alias.simulator.agent_alias_arn
  }
}

resource "aws_bedrockagent_agent_collaborator" "app_invoker" {
  agent_id                  = aws_bedrockagent_agent.supervisor.agent_id
  agent_version             = "DRAFT"
  collaborator_name         = "app-invoker-agent"
  collaboration_instruction = "Delegate requests to invoke a real downstream application endpoint such as scp."
  agent_descriptor {
    alias_arn = aws_bedrockagent_agent_alias.app_invoker.agent_alias_arn
  }
}

resource "aws_bedrockagent_agent_alias" "supervisor" {
  agent_id         = aws_bedrockagent_agent.supervisor.agent_id
  agent_alias_name = "live"
  depends_on = [
    aws_bedrockagent_agent_collaborator.analysis,
    aws_bedrockagent_agent_collaborator.simulator,
    aws_bedrockagent_agent_collaborator.app_invoker,
  ]
}
