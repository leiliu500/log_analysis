export * from './logs.js';
export * from './logGroups.js';
export * from './findings.js';
export * from './agentLifecycle.js';
export * from './agents.js';
export * from './chat.js';
export * from './simulate.js';

/** Small helpers shared across packages. */
export const nowMs = (): number => Date.now();

export function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
