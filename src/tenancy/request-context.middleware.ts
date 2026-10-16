import { Injectable, type NestMiddleware } from '@nestjs/common';
import { RequestContext } from './request-context.js';

/** Opens the request scope for the whole call chain (guards, handlers, services, repositories). */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(private readonly context: RequestContext) {}

  use(request: { id?: unknown }, _response: unknown, next: () => void): void {
    // pino-http assigns `request.id` (from X-Request-Id or a fresh id) after this middleware may
    // have run, so it is read lazily at the moment an audit event or log line needs it.
    this.context.run(
      { requestIdOf: () => (typeof request.id === 'string' ? request.id : undefined) },
      next,
    );
  }
}
