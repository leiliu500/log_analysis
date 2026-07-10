/**
 * `@log/app-scp` — the SCP application's platform-specific integration,
 * decoupled from the generic platform packages. It contributes:
 *   - the named SCP/ESB CloudWatch log groups + content-type resolution
 *     (logGroups.ts), and
 *   - the downstream-application invoker the scp-agent calls (invokeApplication.ts).
 * The generic contracts (InvokeAppRequest/Result, the collaborator enum) stay in
 * `@log/shared`; only SCP-specific data/behavior lives here.
 */
export * from './logGroups.js';
export * from './invokeApplication.js';
export * from './transactionProtocol.js';
