import type { LogSourceType } from '@log/shared';
import type { LogConnector } from './connector.js';
import { CloudWatchConnector } from './cloudwatch.js';
import { SplunkConnector } from './splunk.js';
import { GrafanaLokiConnector } from './grafana.js';
import { EmailConnector } from './email.js';

export * from './connector.js';
export { CloudWatchConnector } from './cloudwatch.js';
export { SplunkConnector } from './splunk.js';
export { GrafanaLokiConnector } from './grafana.js';
export { EmailConnector } from './email.js';

/** Registry: resolve a connector by source type. */
export function connectorFor(source: LogSourceType): LogConnector {
  switch (source) {
    case 'cloudwatch':
      return new CloudWatchConnector();
    case 'splunk':
      return new SplunkConnector();
    case 'grafana':
      return new GrafanaLokiConnector();
    case 'email':
      return new EmailConnector();
    default: {
      const _exhaustive: never = source;
      throw new Error(`No connector for source ${_exhaustive}`);
    }
  }
}

export function allConnectors(): LogConnector[] {
  return [
    new CloudWatchConnector(),
    new SplunkConnector(),
    new GrafanaLokiConnector(),
    new EmailConnector(),
  ];
}
