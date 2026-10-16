import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { parseCorsOrigins, type EnvironmentVariables } from '../../config/env.schema.js';
import { API_VERSION } from '../../meta/contract-version.js';
import { configureNetwork } from './network.js';
import { buildOpenApiDocument, setupSwaggerUi } from './openapi.js';

type AppConfig = ConfigService<EnvironmentVariables, true>;

/**
 * Applies everything that needs the application instance (prefix, docs, security headers, CORS).
 * Shared by `main.ts` and the e2e tests so tests exercise the same HTTP surface as production.
 * Validation pipe and exception filter are registered in AppModule (APP_PIPE / APP_FILTER).
 */
export function configureApp(app: INestApplication): void {
  const config: AppConfig = app.get(ConfigService);

  // Before the first database connection (they are opened lazily, after this runs).
  configureNetwork(
    config.get('DNS_RESULT_ORDER', { infer: true }),
    config.get('NET_ATTEMPT_TIMEOUT_MS', { infer: true }),
  );

  app.setGlobalPrefix(`api/${API_VERSION}`);

  // Behind a reverse proxy the client IP is in X-Forwarded-For: trust exactly this many hops (0 = none).
  // A wrong value makes the per-IP limits and lockout counters spoofable or useless.
  const proxyHops = config.get('TRUST_PROXY', { infer: true });
  if (proxyHops > 0) app.getHttpAdapter().getInstance().set('trust proxy', proxyHops);

  // Swagger is registered before helmet on purpose: its UI needs inline scripts that helmet's
  // default CSP would block. Docs are disabled by default in production.
  if (config.get('SWAGGER_ENABLED', { infer: true })) {
    setupSwaggerUi(app, buildOpenApiDocument(app));
  }

  // Same-site (not same-origin): the web app and API are different origins of one site, and a
  // same-origin policy would block cross-origin images/files served by the API later.
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));

  app.enableCors({
    origin: parseCorsOrigins(config.get('CORS_ORIGINS', { infer: true })),
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Request-Id',
      'X-Requested-With',
      'Idempotency-Key',
    ],
    exposedHeaders: ['X-Request-Id', 'Content-Disposition'],
    maxAge: 600,
  });
}
