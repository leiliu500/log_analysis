import { z } from 'zod';
import { Finding } from './findings.js';
import { ParsedLog } from './logs.js';
import { RouteDecision } from './agents.js';

export const ChatRole = z.enum(['user', 'assistant', 'system', 'tool']);
export type ChatRole = z.infer<typeof ChatRole>;

export const ChatMessage = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  role: ChatRole,
  content: z.string(),
  createdAt: z.number().int(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

/** Request into the chatbot. */
export const ChatRequest = z.object({
  sessionId: z.string().uuid(),
  message: z.string().min(1),
  /**
   * When true the answer is scoped to logs/findings relevant to this session
   * and query only (NOT global findings) — per requirement (7).
   */
  scoped: z.boolean().default(true),
});
export type ChatRequest = z.infer<typeof ChatRequest>;

/** Retrieval context assembled for a scoped chat answer. */
export const ChatContext = z.object({
  findings: z.array(Finding),
  logs: z.array(ParsedLog),
  route: RouteDecision.optional(),
});
export type ChatContext = z.infer<typeof ChatContext>;

export const ChatResponse = z.object({
  sessionId: z.string().uuid(),
  answer: z.string(),
  context: ChatContext,
  route: RouteDecision.optional(),
});
export type ChatResponse = z.infer<typeof ChatResponse>;
