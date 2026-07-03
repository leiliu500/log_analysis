/**
 * Invokes the native Supervisor agent with several prompts, enables trace, and
 * prints which collaborator agent the supervisor delegated each request to —
 * proving multi-agent collaboration end to end.
 */
import {
  BedrockAgentRuntimeClient,
  InvokeAgentCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';

const region = 'us-gov-west-1';
const agentId = process.env.SUP_ID || 'HRTDC1RTKA';
const agentAliasId = process.env.SUP_ALIAS || 'O3GAGYO8TG';
const client = new BedrockAgentRuntimeClient({ region });

const prompts = [
  'simulate 2 request/ack/response messages with message_id=001 to 002',
  'what findings or anomalies do you have about checkout errors?',
  'invoke the scp application with a balance inquiry',
];

function collaboratorsFromTrace(t) {
  const found = [];
  const orch = t?.orchestrationTrace;
  const ci = orch?.invocationInput?.agentCollaboratorInvocationInput;
  if (ci?.agentCollaboratorName) found.push(ci.agentCollaboratorName);
  const obs = orch?.observation?.agentCollaboratorInvocationOutput?.agentCollaboratorName;
  if (obs) found.push(obs);
  // Router classification (which collaborator the supervisor picked).
  const rc = t?.routingClassifierTrace?.invocationInput?.agentCollaboratorInvocationInput;
  if (rc?.agentCollaboratorName) found.push(rc.agentCollaboratorName);
  return found;
}

for (let i = 0; i < prompts.length; i++) {
  const sessionId = `verify-collab-${i}-${'abcdef012345'.slice(0, 8)}${i}`;
  const delegated = new Set();
  let answer = '';
  try {
    const res = await client.send(
      new InvokeAgentCommand({
        agentId,
        agentAliasId,
        sessionId,
        inputText: prompts[i],
        enableTrace: true,
      }),
    );
    for await (const ev of res.completion ?? []) {
      if (ev.trace?.trace) collaboratorsFromTrace(ev.trace.trace).forEach((c) => delegated.add(c));
      if (ev.chunk?.bytes) answer += new TextDecoder().decode(ev.chunk.bytes);
    }
  } catch (err) {
    answer = `ERROR: ${err.name}: ${err.message}`;
  }
  console.log(`\n[${i + 1}] prompt: ${prompts[i]}`);
  console.log(`    delegated to: ${[...delegated].join(', ') || '(none captured)'}`);
  console.log(`    answer: ${answer.slice(0, 220).replace(/\s+/g, ' ')}`);
}
