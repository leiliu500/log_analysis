# CodeBuild pipeline to build + push the API and web Docker images to ECR
# (no local Docker needed) and force an ECS redeploy. Source is a zip uploaded
# to S3 by scripts/publish-images.sh.

resource "aws_s3_bucket" "build_source" {
  bucket_prefix = "${local.name}-build-"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "build_source" {
  bucket                  = aws_s3_bucket.build_source.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ---------------- IAM ----------------
resource "aws_iam_role" "codebuild" {
  name = "${local.name}-codebuild"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "codebuild.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "codebuild" {
  name = "${local.name}-codebuild-policy"
  role = aws_iam_role.codebuild.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "Logs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "*"
      },
      {
        Sid      = "Source"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:GetObjectVersion"]
        Resource = "${aws_s3_bucket.build_source.arn}/*"
      },
      {
        Sid      = "EcrAuth"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Sid    = "EcrPush"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage",
          "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"
        ]
        Resource = [aws_ecr_repository.api.arn, aws_ecr_repository.web.arn]
      },
      {
        Sid      = "RedeployAndMigrate"
        Effect   = "Allow"
        Action   = ["ecs:UpdateService", "ecs:DescribeServices", "ecs:RunTask", "ecs:DescribeTasks"]
        Resource = "*"
      },
      {
        Sid      = "PassTaskRoles"
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = [aws_iam_role.ecs_execution.arn, aws_iam_role.ecs_task.arn]
      }
    ]
  })
}

# ---------------- Project ----------------
resource "aws_cloudwatch_log_group" "codebuild" {
  name              = "/codebuild/${local.name}"
  retention_in_days = 14
}

resource "aws_codebuild_project" "images" {
  name         = "${local.name}-images"
  service_role = aws_iam_role.codebuild.arn

  artifacts { type = "NO_ARTIFACTS" }

  environment {
    compute_type    = "BUILD_GENERAL1_MEDIUM"
    image           = "aws/codebuild/amazonlinux2-x86_64-standard:5.0"
    type            = "LINUX_CONTAINER"
    privileged_mode = true # required for docker build

    environment_variable {
      name  = "ECR_REGISTRY"
      value = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.region}.amazonaws.com"
    }
    environment_variable {
      name  = "API_REPO"
      value = aws_ecr_repository.api.repository_url
    }
    environment_variable {
      name  = "WEB_REPO"
      value = aws_ecr_repository.web.repository_url
    }
    environment_variable {
      name  = "WEB_API_BASE"
      value = "http://${aws_lb.main.dns_name}/api"
    }
    environment_variable {
      name  = "CLUSTER"
      value = aws_ecs_cluster.main.name
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name = aws_cloudwatch_log_group.codebuild.name
    }
  }

  source {
    type      = "S3"
    location  = "${aws_s3_bucket.build_source.bucket}/source.zip"
    buildspec = <<-YAML
      version: 0.2
      phases:
        pre_build:
          commands:
            - echo "Logging in to ECR $ECR_REGISTRY"
            - aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $ECR_REGISTRY
        build:
          commands:
            - echo "Building API image"
            - docker build -f Dockerfile.api -t $API_REPO:latest .
            - echo "Building web image with API base $WEB_API_BASE"
            - docker build -f Dockerfile.web --build-arg NEXT_PUBLIC_API_BASE_URL=$WEB_API_BASE -t $WEB_REPO:latest .
        post_build:
          commands:
            - echo "Pushing images"
            - docker push $API_REPO:latest
            - docker push $WEB_REPO:latest
            - echo "Forcing ECS redeploy"
            - aws ecs update-service --cluster $CLUSTER --service ${local.name}-api --force-new-deployment --region $AWS_DEFAULT_REGION
            - aws ecs update-service --cluster $CLUSTER --service ${local.name}-web --force-new-deployment --region $AWS_DEFAULT_REGION
    YAML
  }
}

output "build_source_bucket" {
  value = aws_s3_bucket.build_source.bucket
}

output "codebuild_project" {
  value = aws_codebuild_project.images.name
}
