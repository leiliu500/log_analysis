import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPrompt, Severity } from '@log/shared';
import { applicationRegistry } from './index.js';

/**
 * Consistency guard: every prompt an application declares by path must actually
 * resolve at runtime. This keeps each app's own prompts — the regular-agent
 * `transaction.md`, the `validation.md`, plus the Log-Assistant / Simulator
 * prompts — wired and separate per app, and fails loudly on a typo or a moved
 * file instead of shipping a dangling reference into the Lambda / API image.
 */

/** All prompt paths an ApplicationDef can declare, labelled for a readable failure. */
function declaredPromptPaths(app: ReturnType<typeof applicationRegistry.all>[number]) {
  return [
    ['transactionPromptPath', app.transactionPromptPath],
    ['validation.promptPath', app.validation?.promptPath],
    ['validation.agentPromptPath', app.validation?.agentPromptPath],
    ['assistantPromptPath', app.assistantPromptPath],
    ['simulateUnderstandingPromptPath', app.simulateUnderstandingPromptPath],
  ] as const;
}

for (const app of applicationRegistry.all()) {
  for (const [field, path] of declaredPromptPaths(app)) {
    if (!path) continue; // optional — only assert the ones this app declares
    test(`${app.id}: ${field} (${path}) loads`, () => {
      const body = loadPrompt(path);
      assert.ok(body.length > 0, `${path} is empty`);
    });
  }
}

test('scp and apiflc each declare their own transaction + validation prompts', () => {
  for (const id of ['scp', 'apiflc']) {
    const app = applicationRegistry.byId(id);
    assert.ok(app, `application ${id} is registered`);
    assert.ok(app!.transactionPromptPath?.includes(`apps/${id}/transaction.md`), `${id} has its own transaction.md`);
    assert.ok(app!.validation?.promptPath.includes(`apps/${id}/validation.md`), `${id} has its own validation.md`);
  }
});

/**
 * The validation AI agent is per-application by construction: its prompt encodes that
 * app's protocol and — critically — the deterministic checks it must NOT restate. A
 * shared prompt would make it duplicate work the worker already does, so assert each app
 * declares its own agent + spec together (one without the other is a silent no-op).
 */
for (const app of applicationRegistry.all()) {
  const v = app.validation;
  if (!v) continue;

  test(`${app.id}: validation agent and its prompt are declared together`, () => {
    assert.equal(
      v.validationAgent === undefined,
      v.agentPromptPath === undefined,
      `${app.id} declares one of validationAgent/agentPromptPath without the other`,
    );
  });

  if (!v.agentPromptPath) continue;

  test(`${app.id}: validation.agent.md is this app's own, and is not the worker spec`, () => {
    assert.ok(v.agentPromptPath!.includes(`apps/${app.id}/validation.agent.md`), `${app.id} needs its own validation.agent.md`);
    assert.notEqual(v.agentPromptPath, v.promptPath, 'the AI agent spec must be separate from the deterministic worker spec');
  });

  test(`${app.id}: validation.agent.md agrees with the executable SLA + phase config`, () => {
    const body = loadPrompt(v.agentPromptPath!);
    assert.ok(body.includes(String(v.responseTimeoutMinutes)), `prompt omits the ${v.responseTimeoutMinutes}-minute budget`);
    for (const phase of app.protocol.allPhases) {
      assert.ok(new RegExp(`\\b${phase}\\b`).test(body), `prompt omits protocol phase ${phase}`);
    }
  });

  /**
   * The admission gate can prove a cited FACT is real; it cannot prove that a real fact
   * is a DEFECT. That gap produced four false positives in prod — an ACK whose messageId
   * differs from its REQUEST, a sender that changes between phases, an authorizer Allow
   * on a call that later 5xx'd — all of them the protocol behaving exactly as specified.
   * The only fix for that class is the spec itself, so every app's agent prompt must
   * carry an explicit list of by-design facts it may never claim. Locked here so a future
   * prompt edit cannot quietly drop it and reopen the same false positives.
   */
  test(`${app.id}: validation.agent.md lists the by-design facts the agent must never claim`, () => {
    const body = loadPrompt(v.agentPromptPath!);
    assert.match(body, /BY DESIGN/, 'prompt needs an explicit "by design — never claim these" section');
    assert.match(body, /NEVER CLAIM/i, 'the section must be phrased as a prohibition');
  });

  test(`${app.id}: validation.agent.md tells the agent to cite evidence and not invent it`, () => {
    // The safety of the AI stage is enforced by the admission gate in code, but the
    // prompt must not fight it: an agent told to speculate just burns discarded claims.
    const body = loadPrompt(v.agentPromptPath!).toLowerCase();
    assert.ok(body.includes('logid'), 'prompt must require citing log ids');
    assert.ok(body.includes('predicate'), 'prompt must require a re-executable predicate');
    assert.ok(body.includes('absent'), 'prompt must forbid inferring a problem from absent evidence');
  });
}

/**
 * Config ↔ protocol consistency. The deterministic validation engine is only as
 * correct as each app's per-app config: a wrong SLA anchor, a phase list out of
 * sync with the protocol, or a `validation.md` that disagrees with the executable
 * numbers produces deterministically wrong verdicts at scale. Assert they line up,
 * so drift fails the build instead of silently mis-validating every transaction.
 */
for (const app of applicationRegistry.all()) {
  const v = app.validation;
  if (!v) continue;
  const proto = app.protocol;
  const completing = proto.phases[proto.phases.length - 1];

  test(`${app.id}: protocol phase list is internally consistent`, () => {
    assert.deepEqual(proto.allPhases, [proto.initial, ...proto.phases], 'allPhases must equal [initial, ...phases]');
    assert.ok(proto.phases.length > 0, 'protocol must define at least one follow-up phase');
  });

  test(`${app.id}: SLA anchor (responseTimeoutFrom) is a real, non-completing phase`, () => {
    assert.ok(proto.allPhases.includes(v.responseTimeoutFrom), `${v.responseTimeoutFrom} is not one of ${proto.allPhases.join('/')}`);
    assert.notEqual(v.responseTimeoutFrom, completing, 'the SLA cannot be anchored on the completing phase');
  });

  test(`${app.id}: responseTimeoutMinutes is a positive, finite number`, () => {
    assert.ok(Number.isFinite(v.responseTimeoutMinutes) && v.responseTimeoutMinutes > 0, `bad budget ${v.responseTimeoutMinutes}`);
  });

  test(`${app.id}: qualityIssueSeverity (if set) is a valid severity`, () => {
    if (v.qualityIssueSeverity) assert.ok(Severity.options.includes(v.qualityIssueSeverity), `bad severity ${v.qualityIssueSeverity}`);
  });

  test(`${app.id}: app-specific validation checks are declared only where the protocol needs them`, () => {
    // SCP's REQUEST→ACK→RESPONSE shape needs ordering/duplicate checks; apiflc's
    // two-phase REQUEST→RESPONSE (no ACK) does not — locks the SCP-only contract.
    if (app.id === 'scp') assert.equal(typeof v.checks, 'function', 'scp must declare its ACK-ordering checks');
    if (app.id === 'apiflc') assert.equal(v.checks, undefined, 'apiflc has no ACK phase and must declare no checks');
  });

  test(`${app.id}: validation.md agrees with the executable SLA + phase config`, () => {
    const body = loadPrompt(v.promptPath);
    assert.ok(body.includes(String(v.responseTimeoutMinutes)), `prompt omits the ${v.responseTimeoutMinutes}-minute budget`);
    assert.ok(new RegExp(`\\b${v.responseTimeoutFrom}\\b`).test(body), `prompt omits the SLA anchor ${v.responseTimeoutFrom}`);
    for (const phase of proto.allPhases) {
      assert.ok(new RegExp(`\\b${phase}\\b`).test(body), `prompt omits protocol phase ${phase}`);
    }
  });
}
