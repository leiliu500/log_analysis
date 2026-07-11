import {
  BedrockAgentRuntimeClient,
  InvokeAgentCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';

const region = process.env.AWS_REGION ?? 'us-east-1';
let _client: BedrockAgentRuntimeClient | undefined;
function client(): BedrockAgentRuntimeClient {
  if (!_client) _client = new BedrockAgentRuntimeClient({ region });
  return _client;
}

/**
 * Invoke the provisioned native Bedrock Supervisor Agent and stream its answer.
 * Use this path in production to exercise Action Groups + collaborator agents;
 * the local {@link routeRequest} is a lighter fallback for dev/tests.
 */
export async function invokeSupervisorAgent(
  sessionId: string,
  inputText: string,
): Promise<string> {
  const agentId = process.env.BEDROCK_SUPERVISOR_AGENT_ID;
  const agentAliasId = process.env.BEDROCK_SUPERVISOR_AGENT_ALIAS_ID;
  if (!agentId || !agentAliasId) {
    throw new Error(
      'BEDROCK_SUPERVISOR_AGENT_ID / _ALIAS_ID not set (deploy infra/ first).',
    );
  }

  const res = await client().send(
    new InvokeAgentCommand({ agentId, agentAliasId, sessionId, inputText }),
  );

  let answer = '';
  for await (const event of res.completion ?? []) {
    if (event.chunk?.bytes) {
      answer += new TextDecoder().decode(event.chunk.bytes);
    }
  }
  return answer.trim();
}
