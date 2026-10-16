import { Global, Module } from '@nestjs/common';
import { RequestContext } from './request-context.js';
import { RequestContextMiddleware } from './request-context.middleware.js';

/** Global: services, repositories and the Prisma safety net all read the same request scope. */
@Global()
@Module({
  providers: [RequestContext, RequestContextMiddleware],
  exports: [RequestContext, RequestContextMiddleware],
})
export class TenancyModule {}
