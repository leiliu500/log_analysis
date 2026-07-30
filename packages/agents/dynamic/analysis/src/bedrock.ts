import {
  BedrockRuntimeClient,
  ConverseCommand,
  InvokeModelCommand,
  type Message,
} from '@aws-sdk/client-bedrock-runtime';

const region = process.env.AWS_REGION ?? 'us-east-1';
const MODEL_ID =
  process.env.BEDROCK_MODEL_ID ?? 'anthropic.claude-sonnet-5-20250101-v1:0';
const EMBED_MODEL_ID =
  process.env.BEDROCK_EMBED_MODEL_ID ?? 'amazon.titan-embed-text-v2:0';

/**
 * The output-token ceiling EVERY agent inherits, in one place.
 *
 * `maxTokens` is a CAP, not a reservation: billing and latency follow the tokens the
 * model actually emits, so a generous ceiling costs nothing on a short reply. A tight one
 * is what actually hurts — the configured foundation model (openai.gpt-oss-120b) is a
 * REASONING model whose hidden reasoning tokens are charged against this same budget, so
 * a low ceiling gets consumed by reasoning and the reply is truncated mid-JSON or comes
 * back empty. That produced silently-failed validation reviews in prod at 2000, and
 * timed-out ingest transitions at 400 before that.
 *
 * Verified against the deployed model: it accepts ceilings up to the full context window
 * without a ValidationException. Individual call sites may still pass a smaller
 * `maxTokens` when they genuinely want a short answer; they inherit this otherwise.
 */
const MAX_TOKENS = Number(process.env.BEDROCK_MAX_TOKENS ?? 32000);

let _client: BedrockRuntimeClient | undefined;
function client(): BedrockRuntimeClient {
  if (!_client) _client = new BedrockRuntimeClient({ region });
  return _client;
}

export interface ConverseOptions {
  system?: string;
  maxTokens?: number;
  temperature?: number;
}

/** Single-shot text completion via the Bedrock Converse API. */
export async function converse(
  prompt: string,
  opts: ConverseOptions = {},
): Promise<string> {
  const messages: Message[] = [{ role: 'user', content: [{ text: prompt }] }];
  const res = await client().send(
    new ConverseCommand({
      modelId: MODEL_ID,
      messages,
      system: opts.system ? [{ text: opts.system }] : undefined,
      inferenceConfig: {
        maxTokens: opts.maxTokens ?? MAX_TOKENS,
        temperature: opts.temperature ?? 0.1,
      },
    }),
  );
  const parts = res.output?.message?.content ?? [];
  return parts.map((p) => ('text' in p ? p.text : '')).join('').trim();
}

/**
 * Converse and parse a JSON object out of the reply. Tolerates models that
 * wrap JSON in prose or ```json fences.
 */
export async function converseJson<T>(
  prompt: string,
  opts: ConverseOptions = {},
): Promise<T> {
  const text = await converse(prompt, opts);
  return extractJson<T>(text);
}

export function extractJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf('{');
  const startArr = candidate.indexOf('[');
  const from =
    start === -1 ? startArr : startArr === -1 ? start : Math.min(start, startArr);
  if (from === -1) throw new Error(`No JSON found in model reply: ${text.slice(0, 200)}`);
  const slice = candidate.slice(from);
  return JSON.parse(slice) as T;
}

/** Embed text with Titan; returns a 1024-dim vector. */
export async function embed(text: string): Promise<number[]> {
  const res = await client().send(
    new InvokeModelCommand({
      modelId: EMBED_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({ inputText: text.slice(0, 8000) }),
    }),
  );
  const body = JSON.parse(new TextDecoder().decode(res.body)) as {
    embedding: number[];
  };
  return body.embedding;
}

export const modelIds = { MODEL_ID, EMBED_MODEL_ID };
/** The inherited output ceiling — exported so a call site can log what it actually got. */
export const maxTokens = MAX_TOKENS;
