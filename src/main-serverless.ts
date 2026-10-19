import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import type { Request, Response } from 'express';
import { AppModule } from './app.module.js';
import { configureApp } from './common/http/configure-app.js';

/** An Express application used as a serverless handler: it is built to be called with a request and a response. */
type HttpHandler = (req: Request, res: Response) => void;

/**
 * The same HTTP surface `main.ts` serves, in the `(req, res)` shape a serverless function is called with, so
 * one deployable build answers on a function host (Vercel) and on an always-on one. The prefix, CORS, helmet,
 * the problem+json filter, throttling and the request id all come from `configureApp`: there is no second
 * router here that could quietly disagree with the first.
 *
 * The application is built once per warm instance. Booting Nest, wiring the modules and (when Swagger is on)
 * generating the OpenAPI document takes seconds, which a function cannot afford per request; after that the
 * instance is reused until the host replaces it, and a function host's disk is not a place anything is kept —
 * which is why files go to object storage and state lives in Postgres.
 */
let instance: Promise<HttpHandler> | null = null;

const buildInstance = async (): Promise<HttpHandler> => {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  configureApp(app);
  app.enableShutdownHooks();
  await app.init();
  return app.getHttpAdapter().getInstance() as HttpHandler;
};

/** A failed boot must not be remembered: the next request tries again rather than replaying the same error. */
const instanceOf = (): Promise<HttpHandler> => {
  instance ??= buildInstance().catch((error: unknown) => {
    instance = null;
    throw error;
  });
  return instance;
};

export default async function handler(req: Request, res: Response): Promise<void> {
  const express = await instanceOf();
  express(req, res);
}
