#!/usr/bin/env bash
#
# Build + push the API and web Docker images via AWS CodeBuild (no local Docker),
# then force an ECS redeploy. This is the source-side half of the image deploy that
# infra/codebuild.tf expects: it zips the committed source, uploads it to the
# CodeBuild S3 source bucket as source.zip, and starts the build. The build itself
# (docker build Dockerfile.api/.web -> ECR -> `ecs update-service --force-new-deployment`)
# runs in CodeBuild per the inline buildspec in infra/codebuild.tf.
#
# Prerequisites:
#   - A VALID target identity is active. This infra lives in AWS GovCloud, so
#     `aws sts get-caller-identity` must return an arn:aws-us-gov principal; the
#     script prints it and refuses to run against the wrong partition unless
#     ALLOW_PARTITION_MISMATCH=1 is set (for reuse in a commercial account).
#   - `terraform apply` has already been run, so the S3 bucket + CodeBuild project
#     exist (their names come from terraform outputs).
#
# Usage:  scripts/publish-images.sh [--follow]
#   --follow   poll the build to completion instead of returning immediately.
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FOLLOW=0
[ "${1:-}" = "--follow" ] && FOLLOW=1

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-gov-west-1}}"

# --- Identity / partition guard ------------------------------------------------
IDENTITY_ARN="$(aws sts get-caller-identity --query Arn --output text)"
echo "Caller:  $IDENTITY_ARN"
echo "Region:  $REGION"
case "$IDENTITY_ARN" in
  arn:aws-us-gov:*) : ;; # GovCloud, as expected
  *)
    if [ "${ALLOW_PARTITION_MISMATCH:-0}" != "1" ]; then
      echo "ERROR: identity is not a GovCloud (arn:aws-us-gov) principal, but this infra is GovCloud." >&2
      echo "       Export a GovCloud profile/credentials, or set ALLOW_PARTITION_MISMATCH=1 to override." >&2
      exit 1
    fi
    echo "WARNING: non-GovCloud identity; proceeding because ALLOW_PARTITION_MISMATCH=1." >&2
    ;;
esac

# --- Resolve the bucket + project from terraform outputs -----------------------
BUCKET="$(terraform -chdir=infra output -raw build_source_bucket)"
PROJECT="$(terraform -chdir=infra output -raw codebuild_project)"
echo "Bucket:  $BUCKET"
echo "Project: $PROJECT"

# --- Package the COMMITTED source ----------------------------------------------
# CodeBuild's S3 source requires the build files at the ZIP ROOT (not nested in a
# top folder). `git archive` does exactly that and skips node_modules/.git and any
# untracked files automatically, so the image is built from committed code only.
ZIP="$(mktemp -t source-XXXXXX).zip"
trap 'rm -f "$ZIP"' EXIT
git archive --format=zip -o "$ZIP" HEAD
echo "Source:  $ZIP ($(du -h "$ZIP" | cut -f1)) from $(git rev-parse --short HEAD) ($(git rev-parse --abbrev-ref HEAD))"

# --- Upload + start the build --------------------------------------------------
aws s3 cp "$ZIP" "s3://$BUCKET/source.zip" --region "$REGION"
BUILD_ID="$(aws codebuild start-build --project-name "$PROJECT" --region "$REGION" --query 'build.id' --output text)"
echo "Started CodeBuild build: $BUILD_ID"

if [ "$FOLLOW" != "1" ]; then
  echo "Follow it with:"
  echo "  aws codebuild batch-get-builds --ids $BUILD_ID --region $REGION --query 'builds[0].buildStatus' --output text"
  exit 0
fi

# --- Poll to completion --------------------------------------------------------
echo "Following build $BUILD_ID ..."
while true; do
  STATUS="$(aws codebuild batch-get-builds --ids "$BUILD_ID" --region "$REGION" --query 'builds[0].buildStatus' --output text)"
  case "$STATUS" in
    SUCCEEDED) echo "Build SUCCEEDED — ECS redeploy triggered for the api + web services."; exit 0 ;;
    FAILED|FAULT|STOPPED|TIMED_OUT) echo "Build $STATUS — see CodeBuild logs /codebuild/<project>." >&2; exit 1 ;;
    *) sleep 15 ;;
  esac
done
