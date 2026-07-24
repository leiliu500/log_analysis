import type { ParsedLog } from '@log/shared';
import { makeParsedLog } from '@log/shared';

/**
 * apiflc-specific backtest fixtures — real-shaped `parsed_logs` across the handler
 * and API-Gateway execution groups, keyed as the live groups are so the cross-log
 * join resolves the HTTP status back to the business correlationID. Lives in the
 * apiflc package (not the shared runner), mirroring how apiflc owns its protocol,
 * join, and HTTP-status derivation.
 */

export const MIN = 60_000;
const HANDLER = '/aws/lambda/adt-fca-d1-api_gateway_handler';
const GW = 'API-Gateway-Execution-Logs_9ioz6z9om1/d1';

/** apiflc handler REQUEST line (business correlationID). */
export function apiflcRequest(timestamp: number, corr: string): ParsedLog {
  return makeParsedLog(HANDLER, timestamp, `2026-07-24T00:00:00.000Z handler-${corr} INFO correlationID: ${corr}; FedLine Request: {`);
}

/** apiflc handler RESPONSE line (business correlationID). */
export function apiflcResponse(timestamp: number, corr: string): ParsedLog {
  return makeParsedLog(HANDLER, timestamp, `2026-07-24T00:00:03.000Z handler-${corr} INFO correlationID: ${corr}; Response from Data Services:`);
}

/**
 * apiflc API-Gateway execution lines carrying the HTTP status — the decisive apiflc
 * outcome, keyed by the gateway requestId and joined back to the correlationID via
 * the X-Correlation-ID header. The gatewayReqId is unique per correlationID so two
 * calls never entangle.
 */
export function apiflcGateway(timestamp: number, corr: string, status: number): ParsedLog[] {
  const gw = `68f54c61-3e54-4e02-8ccf-${corr.padStart(12, '0').slice(0, 12)}`;
  return [
    makeParsedLog(GW, timestamp, `(${gw}) Method request headers: {Accept=*/*, X-Correlation-ID=${corr}, X-Amzn-Trace-Id=Root=1-6a45ea62-54e4e5dd10e9b6af71959157}`),
    makeParsedLog(GW, timestamp + 1, `(${gw}) Received response. Status: ${status}, Integration latency: 120 ms`),
    makeParsedLog(GW, timestamp + 2, `(${gw}) Method completed with status: ${status}`),
  ];
}

/** A full apiflc REQUEST→RESPONSE call: handler request + gateway status + handler response. */
export function apiflcTransaction(base: number, corr: string, status = 200): ParsedLog[] {
  return [apiflcRequest(base, corr), ...apiflcGateway(base + 1000, corr, status), apiflcResponse(base + 3000, corr)];
}
