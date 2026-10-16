import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppException, ErrorCode, type FieldError } from '../errors/app.exception.js';
import { isDatabaseUnavailable } from '../errors/database-unavailable.js';
import type { ProblemDetailsDto } from '../errors/problem-details.dto.js';
import { REQUEST_ID_HEADER, resolveRequestId } from '../http/request-id.js';

const STATUS_CODE_MAP: Readonly<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: ErrorCode.BadRequest,
  [HttpStatus.UNAUTHORIZED]: ErrorCode.Unauthenticated,
  [HttpStatus.FORBIDDEN]: ErrorCode.Forbidden,
  [HttpStatus.NOT_FOUND]: ErrorCode.NotFound,
  [HttpStatus.CONFLICT]: ErrorCode.Conflict,
  [HttpStatus.PAYLOAD_TOO_LARGE]: ErrorCode.PayloadTooLarge,
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: ErrorCode.UnsupportedMediaType,
  [HttpStatus.TOO_MANY_REQUESTS]: ErrorCode.RateLimited,
  [HttpStatus.SERVICE_UNAVAILABLE]: ErrorCode.ServiceUnavailable,
};

const STATUS_TITLE_MAP: Readonly<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
  [HttpStatus.FORBIDDEN]: 'Forbidden',
  [HttpStatus.NOT_FOUND]: 'Not Found',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'Payload Too Large',
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: 'Unsupported Media Type',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'Unprocessable Entity',
  [HttpStatus.TOO_MANY_REQUESTS]: 'Too Many Requests',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'Internal Server Error',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'Service Unavailable',
};

interface HttpErrorLike {
  status?: unknown;
  statusCode?: unknown;
  expose?: unknown;
  type?: unknown;
}

function titleFor(status: number): string {
  return STATUS_TITLE_MAP[status] ?? (status >= 500 ? 'Server Error' : 'Request Error');
}

function codeFor(status: number): string {
  return (
    STATUS_CODE_MAP[status] ?? (status >= 500 ? ErrorCode.InternalError : ErrorCode.BadRequest)
  );
}

/** Errors raised by Express middleware (e.g. body-parser) carry `status` and `expose` instead of being HttpExceptions. */
function middlewareStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { status, statusCode, expose } = error as HttpErrorLike;
  const value =
    typeof status === 'number' ? status : typeof statusCode === 'number' ? statusCode : undefined;
  return value !== undefined && value >= 400 && value < 500 && expose === true ? value : undefined;
}

/**
 * The parts of a database-driver error that explain it but are missing from its message: Prisma's
 * `code`, its `meta` (driver details, column targets: never row values) and the underlying cause.
 * Logged server-side only; never sent to clients.
 */
function driverDetails(error: unknown): string {
  const { code, meta, cause } = error as { code?: unknown; meta?: unknown; cause?: unknown };
  const parts: string[] = [];
  if (typeof code === 'string') parts.push(`code=${code}`);
  if (meta !== undefined) {
    try {
      parts.push(`meta=${JSON.stringify(meta).slice(0, 500)}`);
    } catch {
      // unserialisable meta: skip it
    }
  }
  if (cause instanceof Error) parts.push(`cause=${cause.name}: ${cause.message}`.slice(0, 300));
  return parts.length > 0 ? ` [${parts.join(' ')}]` : '';
}

function extractDetail(response: string | object): string | undefined {
  if (typeof response === 'string') return response;
  const { detail, message } = response as { detail?: unknown; message?: unknown };
  if (typeof detail === 'string') return detail;
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.filter((m) => typeof m === 'string').join('; ');
  return undefined;
}

/**
 * Renders every error as RFC 9457 `application/problem+json` with a stable `code` and the
 * request's correlation id. Unexpected errors are logged in full but never leaked to clients.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & { id?: string }>();
    const response = http.getResponse<Response>();

    const requestId =
      typeof request.id === 'string' && request.id.length > 0
        ? request.id
        : resolveRequestId(request.headers?.[REQUEST_ID_HEADER]);

    const problem = this.toProblem(exception, requestId, request);

    response.setHeader('X-Request-Id', requestId);
    if (problem.code === ErrorCode.DatabaseUnavailable) response.setHeader('Retry-After', '5');
    if (exception instanceof AppException && exception.headers) {
      for (const [name, value] of Object.entries(exception.headers))
        response.setHeader(name, value);
    }
    response.status(problem.status).type('application/problem+json').json(problem);
  }

  private toProblem(exception: unknown, requestId: string, request: Request): ProblemDetailsDto {
    if (exception instanceof AppException) {
      const status = exception.getStatus();
      return this.build(status, exception.code, requestId, exception.detail, exception.errors);
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return this.build(status, codeFor(status), requestId, extractDetail(exception.getResponse()));
    }

    const clientStatus = middlewareStatus(exception);
    if (clientStatus !== undefined) {
      const detail = exception instanceof Error ? exception.message : undefined;
      return this.build(clientStatus, codeFor(clientStatus), requestId, detail);
    }

    if (isDatabaseUnavailable(exception)) {
      // Neon may be waking from scale-to-zero, or unreachable: a retryable state, not a bug.
      this.logger.warn(`Database unavailable [${requestId}] ${request.method} ${request.url}`);
      return this.build(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.DatabaseUnavailable,
        requestId,
        'The database is not reachable. Try again shortly.',
      );
    }

    const error = exception instanceof Error ? exception : new Error(String(exception));
    this.logger.error(
      `Unhandled exception [${requestId}] ${request.method} ${request.url}: ${error.message}${driverDetails(error)}`,
      error.stack,
    );
    return this.build(
      HttpStatus.INTERNAL_SERVER_ERROR,
      ErrorCode.InternalError,
      requestId,
      'An unexpected error occurred.',
    );
  }

  private build(
    status: number,
    code: string,
    requestId: string,
    detail?: string,
    errors?: FieldError[],
  ): ProblemDetailsDto {
    const problem: ProblemDetailsDto = {
      type: `urn:fca:problem:${code.toLowerCase().replaceAll('_', '-')}`,
      title: titleFor(status),
      status,
      code,
      requestId,
    };
    if (detail !== undefined) problem.detail = detail;
    if (errors !== undefined && errors.length > 0) problem.errors = errors;
    return problem;
  }
}
