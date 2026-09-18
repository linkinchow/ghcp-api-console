import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';

export interface HttpFailureSummaryInput {
  status: number;
  contentType?: string;
  body?: { buffer: Buffer; complete: boolean; truncated: boolean };
  sensitiveValues?: readonly string[];
  diagnosticId?: string;
}

const MAX_BYTES = 16 * 1024;
const MAX_EVENTS = 64;
const MAX_SUMMARY = 512;
const REDACTED = '[redacted]';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[a-z][a-z0-9_.:-]{0,63}$/i;
const ENVELOPE_KEYS = new Set(['message', 'code', 'type', 'error', 'status', 'statusCode', 'param', 'request_id', 'requestId']);
type Fields = { message?: unknown; code?: unknown; type?: unknown };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function extract(value: unknown): Fields | undefined {
  if (!record(value)) return undefined;
  if (Object.hasOwn(value, 'error')) {
    if (typeof value.error === 'string') return { message: value.error };
    if (!record(value.error)) return undefined;
    return {
      message: Object.hasOwn(value.error, 'message') ? value.error.message : undefined,
      code: Object.hasOwn(value.error, 'code') ? value.error.code : undefined,
      type: Object.hasOwn(value.error, 'type') ? value.error.type : undefined,
    };
  }
  // Do not mistake a response object, completion, or arbitrary nested JSON for an error.
  if (!Object.keys(value).every((key) => ENVELOPE_KEYS.has(key))) return undefined;
  if (typeof value.message !== 'string' && typeof value.code !== 'string'
      && !(typeof value.type === 'string' && /(?:^|_)error$/.test(value.type))) return undefined;
  return { message: value.message, code: value.code, type: value.type };
}

function parsePayload(text: string, mediaType: string): Fields | undefined {
  if (mediaType === 'application/json' || /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(mediaType)) {
    return extract(JSON.parse(text));
  }
  if (mediaType !== 'text/event-stream') return undefined;
  const events = text.replace(/\r\n/g, '\n').split(/\n\n+/);
  if (events.filter((event) => event.trim()).length > MAX_EVENTS) return undefined;
  let first: Fields | undefined;
  for (const event of events) {
    const data = event.split('\n').filter((line) => line === 'data' || line.startsWith('data:'))
      .map((line) => line === 'data' ? '' : line.slice(5).replace(/^ /, '')).join('\n');
    if (!data || data.trim() === '[DONE]') continue;
    // Validate the entire bounded capture, not just the prefix before a good event.
    const fields = extract(JSON.parse(data));
    if (!first && fields && [fields.message, fields.code, fields.type].some((field) => typeof field === 'string')) first = fields;
  }
  return first;
}

function normalize(text: string): string {
  return text.replace(/[\p{Cf}]/gu, '').replace(/[\p{Cc}\p{Z}]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function replaceKnown(text: string, sensitiveValues: readonly string[]): string | undefined {
  const variants = new Set<string>();
  let totalLength = 0;
  for (const value of sensitiveValues) {
    if (typeof value !== 'string' || !value) continue;
    for (const variant of [normalize(value), normalize(value.replace(/^\s*Bearer\s+/i, ''))]) {
      if (!variant || variants.has(variant) || variant.length > MAX_BYTES) continue;
      variants.add(variant);
      totalLength += variant.length;
      if (variants.size > 128 || totalLength > MAX_BYTES * 2) return undefined;
    }
  }
  if (!variants.size) return text;
  const pattern = [...variants].sort((a, b) => b.length - a.length)
    .map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  // One pass over the original text prevents short secrets from expanding replacement markers.
  return text.replace(new RegExp(pattern, 'g'), () => REDACTED);
}

function sanitize(value: unknown, sensitiveValues: readonly string[]): string | undefined {
  if (typeof value !== 'string') return undefined;
  let text = replaceKnown(normalize(value), sensitiveValues);
  if (text === undefined) return undefined;
  // HTML is never a useful API reason. Withhold it rather than stripping tags.
  if (/<\/?[a-z!][^>]*>/i.test(text) || /&(?:lt|gt);/i.test(text)) return undefined;
  text = text
    .replace(/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"'`]+/gi, REDACTED)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, REDACTED)
    .replace(/\b(?:github_pat_|gh[pousr]_)[a-z0-9_]+/gi, REDACTED)
    .replace(/\bsk-[a-z0-9_-]+/gi, REDACTED)
    .replace(/\beyJ[a-z0-9_-]*\.[a-z0-9_-]+\.[a-z0-9_-]+/gi, REDACTED)
    .replace(/\b(?:bearer|basic)\s+[^\s,;]+/gi, REDACTED)
    .replace(/\b(?:authorization|proxy[-_ ]authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|password|passwd|secret|credential|cookie)\s*(?:provided\s*)?(?:[:=]|\bis\b|\s)\s*(?:"[^"]*"|'[^']*'|`[^`]*`|[^\s,;]+)/gi, REDACTED);
  // Quoted user data is untrusted. Keep only familiar parameter names/paths,
  // so useful validation reasons survive without repeating supplied payloads.
  text = text.replace(/"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`/g, (chunk, double: string | undefined, single: string | undefined, backtick: string | undefined) => {
    const inner = double ?? single ?? backtick ?? '';
    return /^(?:max_tokens|max_completion_tokens|context_length|temperature|top_p|stream|model|messages|tools|tool_choice|tool_calls|tool_call_id)(?:[.\[\]a-z0-9_-]*)$/.test(inner) ? chunk : REDACTED;
  });
  return normalize(text) || undefined;
}

/** A display-only reason; a ref identifies a logged event, not a persisted file. */
export function summarizeHttpFailure(input: HttpFailureSummaryInput): string {
  const validStatus = Number.isInteger(input.status) && input.status >= 100 && input.status <= 599;
  const status = validStatus ? input.status : 502;
  const prefix = `HTTP ${status}`;
  const ref = typeof input.diagnosticId === 'string' && UUID.test(input.diagnosticId) ? ` [ref: ${input.diagnosticId}]` : '';
  const fallback = prefix + ref;
  try {
    const body = input.body;
    if (!validStatus || status >= 200 && status < 300 || !body || body.complete !== true || body.truncated !== false
        || !Buffer.isBuffer(body.buffer) || body.buffer.length > MAX_BYTES) return fallback;
    const mediaType = typeof input.contentType === 'string' ? input.contentType.split(';', 1)[0].trim().toLowerCase() : '';
    const fields = parsePayload(new TextDecoder('utf-8', { fatal: true }).decode(body.buffer), mediaType);
    if (!fields) return fallback;
    const sensitiveValues = Array.isArray(input.sensitiveValues) ? input.sensitiveValues : [];
    const message = sanitize(fields.message, sensitiveValues);
    const identifier = (value: unknown): string | undefined => {
      const safe = sanitize(value, sensitiveValues);
      return safe && IDENTIFIER.test(safe) && safe === value ? safe : undefined;
    };
    const code = identifier(fields.code);
    const type = identifier(fields.type);
    const labels = [code ? `code: ${code}` : '', type ? `type: ${type}` : ''].filter(Boolean).join(', ');
    const detail = [message, labels ? `(${labels})` : ''].filter(Boolean).join(' ');
    if (!detail) return fallback;
    const summary = Array.from(`${prefix}: ${detail}`);
    const budget = MAX_SUMMARY - Array.from(ref).length;
    return (summary.length > budget ? summary.slice(0, budget - 1).join('') + '…' : summary.join('')) + ref;
  } catch {
    // Malformed bytes, JSON, or unexpected runtime input must never escape here.
    return fallback;
  }
}
