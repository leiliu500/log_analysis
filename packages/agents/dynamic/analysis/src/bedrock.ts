import { insertModelCall } from '@log/db';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  InvokeModelCommand,
  type Message,
} from '@aws-sdk/client-bedrock-runtime';
import {
  GuardrailBlockedError,
  blockedMessage,
  firedPolicies,
  guardedContent,
  guardrailConfig,
  wasBlocked,
} from './guardrail.js';

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
  /**
   * Which pipeline stage is asking. Recorded on every call so latency, token use and
   * failure can be attributed to a STAGE rather than averaged into one platform-wide
   * number that hides which part is degrading.
   */
  stage?: string;
  /** Owning application, where the call is made on behalf of one. */
  application?: string;
  /**
   * The span of `prompt` a HUMAN typed, verbatim — the only part scanned for prompt
   * injection when a guardrail is configured.
   *
   * Pass this on any path that embeds an end user's own words (the Log Assistant's
   * question); leave it unset for prompts built solely from our instructions and
   * retrieved logs. Deliberately opt-in: tagging retrieved log content instead would
   * flag routine incident data as an attack, because logs quote the very strings an
   * injection filter looks for. See {@link guardedContent}.
   */
  untrusted?: string;
}

/**
 * Record one model call, best-effort. Telemetry must never be able to fail a model call
 * or slow it down, so this is fire-and-forget and swallows its own errors: a metrics
 * table that is briefly unwritable is a reporting gap, not an outage.
 */
function record(row: Parameters<typeof insertModelCall>[0]): void {
  void insertModelCall(row).catch(() => {});
}

/** Single-shot text completion via the Bedrock Converse API, instrumented. */
export async function converse(
  prompt: string,
  opts: ConverseOptions = {},
): Promise<string> {
  const messages: Message[] = [{ role: 'user', content: guardedContent(prompt, opts.untrusted) }];
  const startedAt = Date.now();
  const base = { ts: startedAt, stage: opts.stage ?? 'unattributed', model: MODEL_ID, application: opts.application };
  let res;
  try {
    res = await client().send(
    new ConverseCommand({
      modelId: MODEL_ID,
      messages,
      system: opts.system ? [{ text: opts.system }] : undefined,
      inferenceConfig: {
        maxTokens: opts.maxTokens ?? MAX_TOKENS,
        temperature: opts.temperature ?? 0.1,
      },
      // Undefined when no guardrail is provisioned, which is exactly the pre-guardrail
      // request — so an unconfigured environment behaves identically rather than failing
      // every call on an identifier that does not resolve.
      guardrailConfig: guardrailConfig(),
    }),
  );
  } catch (err) {
    record({ ...base, ok: false, wallMs: Date.now() - startedAt, error: (err as Error).message.slice(0, 300) });
    throw err;
  }
  const parts = res.output?.message?.content ?? [];
  const text = parts.map((p) => ('text' in p ? p.text : '')).join('').trim();
  // A guardrail intervention is a POLICY outcome, not a transport failure: the call
  // succeeded, was billed, and has real latency and token counts. Record it as such —
  // with the policies that fired — so an operator can tell a blocked request apart from
  // a Bedrock outage, and can see a policy that is firing on legitimate traffic before
  // users report the assistant "not answering".
  if (wasBlocked(res)) {
    const policies = firedPolicies(res.trace);
    record({
      ...base,
      ok: true,
      wallMs: Date.now() - startedAt,
      latencyMs: res.metrics?.latencyMs,
      inputTokens: res.usage?.inputTokens,
      outputTokens: res.usage?.outputTokens,
      replyChars: text.length,
      stopReason: res.stopReason,
      guardrailPolicies: policies,
    });
    throw new GuardrailBlockedError(blockedMessage(res), policies);
  }
  record({
    ...base,
    ok: true,
    wallMs: Date.now() - startedAt,
    // Provider-reported, not our wall clock — kept alongside it so the gap is visible.
    latencyMs: res.metrics?.latencyMs,
    inputTokens: res.usage?.inputTokens,
    outputTokens: res.usage?.outputTokens,
    replyChars: text.length,
    stopReason: res.stopReason,
    // Present without a block when a policy MASKED rather than stopped the reply (a card
    // number anonymised out of an answer). Silent otherwise: the reply is not what the
    // model actually said, and nothing else would ever reveal that.
    guardrailPolicies: firedPolicies(res.trace),
  });
  return text;
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
