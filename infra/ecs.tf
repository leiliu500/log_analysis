# ECR repositories (images pushed by CI, then passed as *_image vars).
resource "aws_ecr_repository" "api" {
  name                 = "${local.name}-api"
  image_tag_mutability = "MUTABLE"
  image_scanning_configuration { scan_on_push = true }
}

resource "aws_ecr_repository" "web" {
  name                 = "${local.name}-web"
  image_tag_mutability = "MUTABLE"
  image_scanning_configuration { scan_on_push = true }
}

resource "aws_ecs_cluster" "main" {
  name = "${local.name}-cluster"
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

# ---------------- Load balancer ----------------
resource "aws_lb" "main" {
  name               = "${local.name}-alb"
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id
}

resource "aws_lb_target_group" "web" {
  name        = "${local.name}-web"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"
  health_check {
    path    = "/"
    matcher = "200-399"
  }
}

resource "aws_lb_target_group" "api" {
  name        = "${local.name}-api"
  port        = 4000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"
  health_check {
    path    = "/health"
    matcher = "200"
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

# The API is served under /api/* so it doesn't collide with the Next.js UI
# routes (/chat, /simulate). Everything else falls through to the web service.
resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 10
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
  condition {
    path_pattern {
      values = ["/api", "/api/*"]
    }
  }
}

# ---------------- Task definitions ----------------
resource "aws_cloudwatch_log_group" "ecs" {
  name              = "/ecs/${local.name}"
  retention_in_days = 30
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "1024"
  memory                   = "2048"
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn
  container_definitions = jsonencode([{
    name      = "api"
    image     = var.api_image != "" ? var.api_image : "${aws_ecr_repository.api.repository_url}:latest"
    essential = true
    portMappings = [{ containerPort = 4000 }]
    environment = [
      { name = "API_PORT", value = "4000" },
      { name = "AWS_REGION", value = var.region },
      { name = "DATABASE_URL", value = local.database_url },
      { name = "APP_ENDPOINTS_JSON", value = var.app_endpoints_json },
      { name = "CLOUDWATCH_LOG_GROUPS", value = join(",", concat(var.cloudwatch_log_groups, var.application_log_groups)) },
      { name = "BEDROCK_MODEL_ID", value = local.foundation_model },
      { name = "BEDROCK_EMBED_MODEL_ID", value = "amazon.titan-embed-text-v2:0" },
      # Output-token ceiling inherited by every agent in the API container (Log
      # Assistant, chat, simulator, on-demand analysis). Kept identical to the Lambdas'
      # so the same question answered by either half gets the same budget.
      { name = "BEDROCK_MAX_TOKENS", value = tostring(var.bedrock_max_tokens) },
      # The API runs the SAME validateAgents() as the scheduled Lambda whenever someone
      # hits "Validate now", so it must be configured identically. Without these it fell
      # back to code defaults — and the default review epoch is 0, meaning a manual run
      # treated every stored AI review as current: it would neither re-review after a
      # corrected prompt nor clear a superseded verdict, silently undoing on-demand what
      # the scheduled poller had just fixed.
      { name = "VALIDATION_AI_ENABLED", value = tostring(var.validation_ai_enabled) },
      { name = "VALIDATION_AI_MAX_PER_POLL", value = tostring(var.validation_ai_max_per_poll) },
      { name = "VALIDATION_AI_DEADLINE_MS", value = tostring(var.validation_ai_deadline_ms) },
      { name = "VALIDATION_AI_REVIEW_EPOCH", value = tostring(var.validation_ai_review_epoch) },
      { name = "BEDROCK_SUPERVISOR_AGENT_ID", value = aws_bedrockagent_agent.supervisor.agent_id },
      { name = "BEDROCK_SUPERVISOR_AGENT_ALIAS_ID", value = aws_bedrockagent_agent_alias.supervisor.agent_alias_id }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.ecs.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "api"
      }
    }
  }])
}

resource "aws_ecs_task_definition" "web" {
  family                   = "${local.name}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn
  container_definitions = jsonencode([{
    name      = "web"
    image     = var.web_image != "" ? var.web_image : "${aws_ecr_repository.web.repository_url}:latest"
    essential = true
    portMappings = [{ containerPort = 3000 }]
    environment = [
      { name = "NEXT_PUBLIC_API_BASE_URL", value = "http://${aws_lb.main.dns_name}/api" }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.ecs.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "web"
      }
    }
  }])
}

# ---------------- Services ----------------
resource "aws_ecs_service" "api" {
  name            = "${local.name}-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = 2
  launch_type     = "FARGATE"
  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.service.id]
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 4000
  }
  depends_on = [aws_lb_listener_rule.api]
}

resource "aws_ecs_service" "web" {
  name            = "${local.name}-web"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.web.arn
  desired_count   = 2
  launch_type     = "FARGATE"
  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.service.id]
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3000
  }
  depends_on = [aws_lb_listener.http]
}
