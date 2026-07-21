// @log/agents package entry — the Lambda bundle + API import surface. Aggregates
// the Bedrock agent layer (./bedrock), the application registry, and the
// ingestion poller handler.
export * from './bedrock/index.js';
export * from '@log/applications';
export {
  handler as ingestPollerHandler,
  analyzeAllSources,
  // The autonomous validation poller — a separate Lambda entry, isolated from the
  // ingest path (reads agents+findings, writes validation_agents only). It lives in
  // @log/ingestion so it can inject the same application registry the ingest poller uses.
  validationPollerHandler,
} from '@log/ingestion';
export { validateAgents } from '@log/analysis';
