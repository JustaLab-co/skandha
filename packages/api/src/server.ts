import { AsyncResource } from "node:async_hooks";
import fastify, {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import RpcError from "@skandha/types/lib/api/errors/rpc-error.js";
import { ServerConfig } from "@skandha/types/lib/api/interfaces";
import {
  TraceContext,
  newTraceId,
  traceIdFromHeaders,
  traceStorage,
} from "@skandha/utils/lib/traceContext.js";
import logger from "./logger.js";
import { HttpStatus } from "./constants.js";
import { JsonRpcRequest } from "./interface.js";

export class Server {
  constructor(
    public http: FastifyInstanceAny,
    public ws: FastifyInstanceAny | null,
    private config: ServerConfig
  ) {}

  static async init(config: ServerConfig): Promise<Server> {
    let ws: FastifyInstanceAny | null = null;
    const app = fastify({
      logger,
      disableRequestLogging: !config.enableRequestLogging,
      ignoreTrailingSlash: true,
    });

    await app.register(cors, {
      origin: config.cors,
    });

    if (config.ws) {
      if (config.wsPort == config.port) {
        await app.register(websocket);
        ws = app;
      } else {
        ws = fastify({
          logger,
          disableRequestLogging: !config.enableRequestLogging,
          ignoreTrailingSlash: true,
        });
      }
    }

    addTraceHooks(app);
    if (ws && ws !== app) addTraceHooks(ws);

    app.addHook("preHandler", (req, reply, done) => {
      
      if (req.url === "/version" || req.url === "/healthcheck") {
        // do nothing
      } else if (req.method === "POST") {
        req.log.info(
          {
            method: req.method,
            url: req.url,
            body: req.body,
          },
          "REQUEST ::"
        );
      } else {
        req.log.info(
          {
            method: req.method,
            url: req.url,
          },
          "REQUEST ::"
        );
      }
      done();
    });
    // RESPONSE LOG
    app.addHook("preSerialization", (request, reply, payload, done) => {
      if (payload) {
        request.log.info({ body: payload }, "RESPONSE ::");
      }
      done();
    });

    return new Server(app, ws, config);
  }

  async listen(): Promise<void> {
    const errorHandler = (
      err: FastifyError,
      req: FastifyRequest,
      res: FastifyReply
    ): FastifyReply => {
      // eslint-disable-next-line no-console
      logger.error(err);

      if (err instanceof RpcError) {
        const body = req.body as JsonRpcRequest;
        const error = {
          message: err.message,
          data: err.data,
          code: err.code,
        };
        return res.status(HttpStatus.OK).send({
          jsonrpc: body.jsonrpc,
          id: body.id,
          error,
        });
      }

      return res
        .status(err.statusCode ?? HttpStatus.INTERNAL_SERVER_ERROR)
        .send({
          error: "Unexpected behaviour",
        });
    };

    this.http.setErrorHandler(errorHandler);
    this.http.listen(
      {
        port: this.config.port,
        host: this.config.host,
        listenTextResolver: (address) =>
          `HTTP server listening at ${address}/rpc`,
      },
      (err) => {
        if (err) throw err;
        if (this.http.websocketServer != null) {
          this.http.log.info(
            `Websocket server listening at ws://${this.config.host}:${this.config.port}/rpc`
          );
        }
      }
    );

    if (this.config.ws && this.config.wsPort != this.config.port) {
      this.ws?.setErrorHandler(errorHandler);
      this.ws?.listen(
        {
          port: this.config.wsPort,
          host: this.config.host,
          listenTextResolver: () =>
            `Websocket server listening at ws://${this.config.host}:${this.config.wsPort}/rpc`,
        },
        (err) => {
          if (err) throw err;
        }
      );
    }
  }
}

declare module "fastify" {
  interface FastifyRequest {
    traceContext: TraceContext | null;
    traceResource: AsyncResource | null;
  }
}

/**
 * Runs every request inside an AsyncLocalStorage holding its traceId, taken
 * from the caller's traceparent / b3 header (or generated when absent), so the
 * logger mixin can put it on every line. Same pattern as @fastify/request-context:
 * body parsing runs in stream callbacks that lose the context, so it is
 * captured in onRequest and restored in preValidation.
 */
function addTraceHooks(app: FastifyInstanceAny): void {
  app.decorateRequest("traceContext", null);
  app.decorateRequest("traceResource", null);

  app.addHook("onRequest", (req, _reply, done) => {
    const traceContext: TraceContext = {
      traceId: traceIdFromHeaders(req.headers) ?? newTraceId(),
    };
    req.traceContext = traceContext;
    traceStorage.run(traceContext, () => {
      req.traceResource = new AsyncResource("skandha-trace");
      done();
    });
  });

  app.addHook("preValidation", (req, _reply, done) => {
    if (req.traceResource) {
      req.traceResource.runInAsyncScope(done, req.raw);
    } else {
      done();
    }
  });
}

/// @note to address the bug in fastify types, will be removed in future
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FastifyInstanceAny = FastifyInstance<any, any, any, any, any>;
