output "alb_dns_name" {
  description = "Public URL for the dashboard + API."
  value       = "http://${aws_lb.main.dns_name}"
}

output "supervisor_agent_id" {
  value = aws_bedrockagent_agent.supervisor.agent_id
}

output "supervisor_agent_alias_id" {
  value = aws_bedrockagent_agent_alias.supervisor.agent_alias_id
}

output "guardrail_id" {
  description = "Bedrock Guardrail applied to every model call. Empty when guardrail_enabled = false."
  value       = local.guardrail_id
}

output "guardrail_version" {
  description = "Pinned guardrail version. Policy edits do NOT take effect until guardrail_revision is bumped."
  value       = local.guardrail_version
}

output "rds_endpoint" {
  value = aws_db_instance.postgres.address
}

output "db_secret_arn" {
  value = aws_secretsmanager_secret.db.arn
}

output "ecr_api_repo" {
  value = aws_ecr_repository.api.repository_url
}

output "ecr_web_repo" {
  value = aws_ecr_repository.web.repository_url
}

output "action_group_lambda" {
  value = aws_lambda_function.action_group.function_name
}

output "application_log_groups" {
  description = "Named application log groups the simulator writes to."
  value       = [for lg in aws_cloudwatch_log_group.application : lg.name]
}
