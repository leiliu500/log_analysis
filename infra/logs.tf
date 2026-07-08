# Named application CloudWatch log groups (SCP / SCP REST app / ESB cash agent).
# The simulator writes correlated messages into these based on the requested
# target log group or content type; the ingestion pipeline reads from them.
resource "aws_cloudwatch_log_group" "application" {
  for_each          = toset(var.application_log_groups)
  name              = each.value
  retention_in_days = 30
  tags = {
    Project     = var.project
    Environment = var.environment
  }
}
