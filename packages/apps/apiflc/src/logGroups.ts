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

/**
 * Detect an apiflc target log group named in a message — an exact group name, or
 * a content-type keyword (handler / authorizer / background / gateway/execution).
 * Returns undefined when nothing matches (the simulator falls back to other apps).
 */
export function parseApiflcLogGroup(message: string): ApiflcLogGroup | undefined {
  for (const g of APIFLC_LOG_GROUPS) if (message.includes(g)) return g;
  const m = message.toLowerCase();
  if (/\bauthoriz/.test(m)) return '/aws/lambda/adt-fca-d1-api_gateway_authorizer';
  if (/\bbackground\b/.test(m)) return '/aws/lambda/adt-fca-d1-api_gateway_background';
  if (/\bexecution[-\s]?log|\bapi[-\s]?gateway[-\s]?exec/.test(m)) return 'API-Gateway-Execution-Logs_9ioz6z9om1/d1';
  if (/\bapiflc\b|\bapi[-\s_]?gateway\b|\badt-fca\b|\bfca\b/.test(m)) return '/aws/lambda/adt-fca-d1-api_gateway_handler';
  return undefined;
}
