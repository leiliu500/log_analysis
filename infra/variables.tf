variable "project" {
  type    = string
  default = "log-analysis"
}

variable "environment" {
  type    = string
  default = "prod"
}

variable "region" {
  type    = string
  default = "us-gov-west-1"
}

variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}

variable "az_count" {
  type    = number
  default = 2
}

variable "bedrock_model_arn" {
  description = "Foundation model ARN the agents use (Claude on Bedrock)."
  type        = string
  default     = "openai.gpt-oss-120b-1:0"
}

variable "db_username" {
  type    = string
  default = "loguser"
}

variable "db_name" {
  type    = string
  default = "loganalysis"
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}

variable "api_image" {
  description = "ECR image URI for the API service (built + pushed via CI)."
  type        = string
  default     = ""
}

variable "web_image" {
  description = "ECR image URI for the web dashboard."
  type        = string
  default     = ""
}

variable "cloudwatch_log_groups" {
  type    = list(string)
  default = ["/aws/lambda/my-app"]
}

variable "app_endpoints_json" {
  description = "JSON map of appName -> real endpoint for the app-invoker agent."
  type        = string
  default     = "{\"scp\":\"https://scp.example.internal/api/execute\"}"
}
