import { Module, RequestMethod, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AuditModule } from './audit/audit.module.js';
import { BusinessUnitsModule } from './business-units/business-units.module.js';
import { ComplianceMappingsModule } from './compliance-mappings/compliance-mappings.module.js';
import { GovernanceAreasModule } from './governance-areas/governance-areas.module.js';
import { FrameworksModule } from './frameworks/frameworks.module.js';
import { PlansModule } from './plans/plans.module.js';
import { SettingsModule } from './settings/settings.module.js';
import { StorageModule } from './storage/storage.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ClockModule } from './common/clock.module.js';
import { ProblemDetailsFilter } from './common/filters/problem-details.filter.js';
import { REQUEST_ID_HEADER, resolveRequestId } from './common/http/request-id.js';
import { createValidationPipe } from './common/pipes/validation.pipe.js';
import { NodeEnv, validateEnv, type EnvironmentVariables } from './config/env.schema.js';
import { HealthModule } from './health/health.module.js';
import { MetaModule } from './meta/meta.module.js';
import { OrganisationsModule } from './organisations/organisations.module.js';
import { PlatformModule } from './platform/platform.module.js';
import { DatabaseModule } from './database/database.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RequestContextMiddleware } from './tenancy/request-context.middleware.js';
import { TenancyModule } from './tenancy/tenancy.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
      // Tests and the OpenAPI export must be hermetic: never pick up a developer's .env file.
      ignoreEnvFile: process.env.NODE_ENV === NodeEnv.Test,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL', { infer: true }),
          genReqId: (request, response) => {
            const id = resolveRequestId(request.headers[REQUEST_ID_HEADER]);
            response.setHeader('X-Request-Id', id);
            return id;
          },
          // Compact request/response lines: never log headers, bodies or query strings (they can
          // carry personal data or tokens).
          serializers: {
            req: (request: { id?: string; method?: string; url?: string }) => ({
              id: request.id,
              method: request.method,
              path: request.url?.split('?')[0],
            }),
            res: (response: { statusCode?: number }) => ({ statusCode: response.statusCode }),
          },
          redact: {
            paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
            censor: '[redacted]',
          },
          autoLogging: { ignore: (request) => (request.url ?? '').startsWith('/api/v1/health') },
          transport:
            config.get('NODE_ENV', { infer: true }) === NodeEnv.Development
              ? { target: 'pino-pretty', options: { singleLine: true, colorize: true } }
              : undefined,
        },
      }),
    }),
    ClockModule,
    TenancyModule,
    PrismaModule,
    DatabaseModule,
    AuditModule,
    AuthModule,
    StorageModule,
    OrganisationsModule,
    SettingsModule,
    BusinessUnitsModule,
    FrameworksModule,
    GovernanceAreasModule,
    ComplianceMappingsModule,
    PlansModule,
    PlatformModule,
    HealthModule,
    MetaModule,
  ],
  providers: [
    { provide: APP_PIPE, useFactory: createValidationPipe },
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Opens the request scope (request id, later actor and tenant) for the whole call chain.
    consumer
      .apply(RequestContextMiddleware)
      .forRoutes({ path: '{*path}', method: RequestMethod.ALL });
  }
}
