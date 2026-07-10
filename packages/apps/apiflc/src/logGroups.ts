/**
 * The CloudWatch log groups the apiflc application owns. The API-Gateway
 * execution-log group is matched by prefix (its full name carries a trailing
 * "/<stage>" path). These are external/real groups (not created by our
 * Terraform) — the poller reads them via CLOUDWATCH_LOG_GROUPS.
 */
export const APIFLC_LOG_GROUPS = [
  '/aws/lambda/adt-fca-d1-api_gateway_handler',
  '/aws/lambda/adt-fca-d1-api_gateway_authorizer',
  '/aws/lambda/adt-fca-d1-api_gateway_background',
  'API-Gateway-Execution-Logs_9ioz6z9om1/d1',
] as const;

export type ApiflcLogGroup = (typeof APIFLC_LOG_GROUPS)[number];
