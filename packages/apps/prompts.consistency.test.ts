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
