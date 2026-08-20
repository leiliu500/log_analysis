# ---------------------------------------------------------------------------
# Native Bedrock Agents + Flow (requirements 1 & 11)
#
# Topology:
#   supervisor (SUPERVISOR_ROUTER) --routes--> collaborator agents
#     - analysis-agent      : query findings / analyze logs
#     - simulator-agent     : generate simulated logs
#     - scp-agent   : call real application endpoints (e.g. scp)
#   All collaborators share one action-group Lambda, dispatched by apiPath.
# ---------------------------------------------------------------------------

locals {
  # Agent + reasoning foundation model, driven by var.bedrock_model_arn
  # (default "openai.gpt-oss-120b-1:0" — the model this account's existing
  # agents already use successfully). A plain model id, as GovCloud expects.
  foundation_model = var.bedrock_model_arn

  # Guardrail attachment, shared by every hosted agent below. Empty list ⇒ no
  # guardrail_configuration block at all, which is the exact pre-guardrail agent.
  #
  # These agents are the platform's highest-stakes model surface: the supervisor routes a
  # user's words to a collaborator that calls invokeApplication against a REAL downstream
  # endpoint, so an injected instruction here causes an ACTION rather than a wrong answer.
  # They also run entirely inside Bedrock — converse()'s in-process guardrail never sees
  # these turns, so this is the only place they can be protected.
  guardrail_attachment = var.guardrail_enabled ? [{
    guardrail_identifier = local.guardrail_id
    guardrail_version    = local.guardrail_version
  }] : []
}

# NOTE: the analysis-agent and simulator-agent collaborators were removed — the
# live app uses in-process equivalents (analyzeAllSources / answerLogQuestion for
# analysis, @log/simulator for simulation), so the hosted agents were unused.

# ---------------- Collaborator: scp-agent ----------------
resource "aws_bedrockagent_agent" "scp" {
  agent_name              = "${local.name}-scp-agent"
  agent_resource_role_arn = aws_iam_role.bedrock_agent.arn
  foundation_model        = local.foundation_model

  # The collaborator that actually calls out to a real application endpoint — the one
  # place in this stack where a model decision becomes an outbound request.
  dynamic "guardrail_configuration" {
    for_each = local.guardrail_attachment
    content {
      guardrail_identifier = guardrail_configuration.value.guardrail_identifier
      guardrail_version    = guardrail_configuration.value.guardrail_version
    }
  }

  instruction = <<-EOT
    You invoke real downstream applications (e.g. scp) using the invokeApplication
    tool with the user's request payload. Summarize status and response.
  EOT
}

resource "aws_bedrockagent_agent_action_group" "scp_actions" {
  agent_id          = aws_bedrockagent_agent.scp.agent_id
  agent_version     = "DRAFT"
  action_group_name = "log-tools"
  action_group_executor { lambda = aws_lambda_function.action_group.arn }
  api_schema { payload = file("${path.module}/schemas/actions.openapi.json") }
}

resource "aws_bedrockagent_agent_alias" "scp" {
  agent_id         = aws_bedrockagent_agent.scp.agent_id
  agent_alias_name = "live"
  depends_on       = [aws_bedrockagent_agent_action_group.scp_actions]
}

# ---------------- Supervisor (router) ----------------
resource "aws_bedrockagent_agent" "supervisor" {
  agent_name                  = "${local.name}-supervisor"
  agent_resource_role_arn     = aws_iam_role.bedrock_agent.arn
  foundation_model            = local.foundation_model
  agent_collaboration         = "SUPERVISOR_ROUTER"
  idle_session_ttl_in_seconds = 1800
  # Defer preparation: a SUPERVISOR_ROUTER cannot be prepared until collaborators
  # are attached, and those depend on this agent existing first. The alias step
  # (which depends on the collaborators) prepares it once they're in place.
  prepare_agent = false

  # First thing the user's raw words hit. Scanning here means an injection is caught
  # before routing rather than inside whichever collaborator it was steered toward.
  dynamic "guardrail_configuration" {
    for_each = local.guardrail_attachment
    content {
      guardrail_identifier = guardrail_configuration.value.guardrail_identifier
      guardrail_version    = guardrail_configuration.value.guardrail_version
    }
  }

  instruction = <<-EOT
    You are the Supervisor. Parse and extract intent from the user request and
    route to exactly one collaborator:
      - scp-agent to call a real application endpoint (e.g. scp)
    Do not answer directly; delegate. Pass through the user's parameters.
  EOT
}

resource "aws_bedrockagent_agent_collaborator" "scp" {
  agent_id                   = aws_bedrockagent_agent.supervisor.agent_id
  agent_version              = "DRAFT"
  collaborator_name          = "scp-agent"
  collaboration_instruction  = "Delegate requests to invoke a real downstream application endpoint such as scp."
  relay_conversation_history = "TO_COLLABORATOR"
  agent_descriptor {
    alias_arn = aws_bedrockagent_agent_alias.scp.agent_alias_arn
  }
}

resource "aws_bedrockagent_agent_alias" "supervisor" {
  agent_id         = aws_bedrockagent_agent.supervisor.agent_id
  agent_alias_name = "live"
  depends_on = [
    aws_bedrockagent_agent_collaborator.scp,
  ]
}
