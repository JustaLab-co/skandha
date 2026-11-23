import pino from "pino";
import * as dotenv from 'dotenv';
import { getTraceContext } from "@skandha/utils/lib/traceContext.js";
dotenv.config();

// LOG_FORMAT=json writes one JSON object per line (for Loki); anything else
// keeps the colorized pino-pretty output. JSON is opt-in per deployment:
// the Grafana bundler alerts match the pretty format, so switch them to
// match JSON too before setting LOG_FORMAT=json.
const pretty = process.env.LOG_FORMAT !== "json";

// Severities fatal - 60, error - 50, warn - 40, info - 30, debug - 20, trace - 10
// if LOG_LEVEL is set to "info" severity, then debug and trace logs will be suppressed
const logger = pino({
  enabled: !process.env.BENCHMARK,
  level: process.env.LOG_LEVEL || "trace",
  ...(pretty
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
          },
        },
      }
    : {
        timestamp: pino.stdTimeFunctions.isoTime,
        formatters: {
          level: (label: string) => ({ level: label }),
        },
      }),
  // Puts the request's traceId (and userOpHash, once known) on every log line
  mixin() {
    const ctx = getTraceContext();
    if (!ctx) return {};
    return ctx.userOpHash
      ? { traceId: ctx.traceId, userOpHash: ctx.userOpHash }
      : { traceId: ctx.traceId };
  },
  serializers: {
    res: () => null,
    req: (req) => ({
      method: req.method,
      url: req.url,
      path: req.path,
      body: req.body,
    }),
  },
});

export type Logger = typeof logger;

export default logger;
