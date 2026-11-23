import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

/**
 * Per-request trace context. The API layer starts it from the caller's
 * `traceparent` / `b3` header, and the logger mixin stamps its fields on
 * every log line written while handling that request.
 */
export interface TraceContext {
  traceId: string;
  userOpHash?: string;
}

export const traceStorage = new AsyncLocalStorage<TraceContext>();

export function getTraceContext(): TraceContext | undefined {
  return traceStorage.getStore();
}

/** Attach the userOpHash to the current request, once it is known */
export function setTraceUserOpHash(userOpHash: string): void {
  const store = traceStorage.getStore();
  if (store) store.userOpHash = userOpHash;
}

export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

const HEX_TRACE_ID = /^(?:[\da-f]{16}|[\da-f]{32})$/;
const INVALID_TRACE_ID = /^0+$/;
// W3C trace context: 00-<32 hex traceId>-<16 hex spanId>-<2 hex flags>
const TRACEPARENT = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}/;

function normalize(traceId: string | undefined): string | undefined {
  if (!traceId) return undefined;
  const id = traceId.trim().toLowerCase();
  if (!HEX_TRACE_ID.test(id) || INVALID_TRACE_ID.test(id)) return undefined;
  // B3 allows 64-bit ids; OpenTelemetry left-pads them to 128 bits
  return id.padStart(32, "0");
}

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Reads the trace id from W3C `traceparent`, then B3 single (`b3`),
 * then B3 multi (`x-b3-traceid`) headers.
 */
export function traceIdFromHeaders(
  headers: Record<string, string | string[] | undefined>
): string | undefined {
  const traceparent = header(headers, "traceparent")?.trim().toLowerCase();
  const fromTraceparent = normalize(traceparent?.match(TRACEPARENT)?.[1]);
  if (fromTraceparent) return fromTraceparent;

  const fromB3 = normalize(header(headers, "b3")?.split("-")[0]);
  if (fromB3) return fromB3;

  return normalize(header(headers, "x-b3-traceid"));
}
