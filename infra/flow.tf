# Bedrock Flow (requirement 1: "agents and flow").
# A minimal flow: Input -> Agent (supervisor) -> Output. Extend with prompt,
# condition, and knowledge-base nodes as needed.
#
# NOTE: the node/connection schema for aws_bedrockagent_flow evolves across
# provider versions — validate against your pinned aws provider before apply.
resource "aws_bedrockagent_flow" "log_analysis" {
  name               = "${local.name}-flow"
  execution_role_arn = aws_iam_role.bedrock_agent.arn
  description        = "Routes an inbound request through the supervisor agent."

  definition {
    node {
      name = "FlowInput"
      type = "Input"
      output {
        name = "document"
        type = "String"
      }
    }

    node {
      name = "SupervisorAgent"
      type = "Agent"
      configuration {
        agent {
          agent_alias_arn = aws_bedrockagent_agent_alias.supervisor.agent_alias_arn
        }
      }
      input {
        name       = "agentInputText"
        type       = "String"
        expression = "$.data"
      }
      output {
        name = "agentResponse"
        type = "String"
      }
    }

    node {
      name = "FlowOutput"
      type = "Output"
      input {
        name       = "document"
        type       = "String"
        expression = "$.data"
      }
    }

    connection {
      name   = "input_to_agent"
      source = "FlowInput"
      target = "SupervisorAgent"
      type   = "Data"
      configuration {
        data {
          source_output = "document"
          target_input  = "agentInputText"
        }
      }
    }

    connection {
      name   = "agent_to_output"
      source = "SupervisorAgent"
      target = "FlowOutput"
      type   = "Data"
      configuration {
        data {
          source_output = "agentResponse"
          target_input  = "document"
        }
      }
    }
  }
}
