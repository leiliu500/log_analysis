/**
 * `@log/app-apiflc` — the apiflc application's platform-specific integration,
 * decoupled from the generic platform packages (mirrors `@log/app-scp`). It
 * contributes apiflc's CloudWatch log groups and its REQUEST→RESPONSE transaction
 * protocol. The generic contracts stay in `@log/shared`; only apiflc-specific
 * data/behavior lives here.
 */
export * from './logGroups.js';
export * from './transactionProtocol.js';
export * from './join.js';
export * from './samples.js';
export * from './simulateApiflc.js';
export * from './application.js';
export * from './agent.js';
export * from './httpOutcomes.js';
export * from './reconcile.js';
export * from './validationAgent.js';
