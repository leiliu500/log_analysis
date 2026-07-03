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

# The AWS provider (v6) can create the flow but has NO resources for flow
# versions or aliases, and it leaves the flow NotPrepared. Drive the remaining
# deployment steps via the CLI: prepare -> wait Prepared -> create version ->
# create/update the "live" alias to point at it. Re-runs when the flow changes.
resource "terraform_data" "flow_deploy" {
  triggers_replace = [aws_bedrockagent_flow.log_analysis.arn, var.flow_revision]

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = <<-EOT
      set -e
      FID=${aws_bedrockagent_flow.log_analysis.id}
      RGN=${var.region}
      echo "Preparing flow $FID"
      aws bedrock-agent prepare-flow --flow-identifier "$FID" --region "$RGN" >/dev/null
      for i in $(seq 1 40); do
        s=$(aws bedrock-agent get-flow --flow-identifier "$FID" --region "$RGN" --query status --output text)
        echo "  flow status: $s"
        [ "$s" = "Prepared" ] && break
        sleep 3
      done
      VER=$(aws bedrock-agent create-flow-version --flow-identifier "$FID" --region "$RGN" --query version --output text)
      echo "Created flow version $VER"
      AID=$(aws bedrock-agent list-flow-aliases --flow-identifier "$FID" --region "$RGN" --query "flowAliasSummaries[?name=='live'].id | [0]" --output text)
      if [ "$AID" = "None" ] || [ -z "$AID" ]; then
        aws bedrock-agent create-flow-alias --flow-identifier "$FID" --name live --region "$RGN" \
          --routing-configuration "[{\"flowVersion\":\"$VER\"}]" >/dev/null
        echo "Created alias 'live' -> v$VER"
      else
        aws bedrock-agent update-flow-alias --flow-identifier "$FID" --alias-identifier "$AID" --name live --region "$RGN" \
          --routing-configuration "[{\"flowVersion\":\"$VER\"}]" >/dev/null
        echo "Updated alias 'live' -> v$VER"
      fi
    EOT
  }
}

output "flow_id" {
  value = aws_bedrockagent_flow.log_analysis.id
}
