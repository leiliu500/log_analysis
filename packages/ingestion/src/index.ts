// The ingestion package: log-source connectors (under ./source) plus the
// scheduled ingestion poller that pulls from every source and dispatches
// agentic analysis + the transaction-agent lifecycle.
export * from './source/index.js';
export * from './ingestPoller.js';
