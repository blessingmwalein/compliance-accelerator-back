import {
  BadRequestException,
  HttpStatus,
  Logger,
  NotFoundException,
  type ArgumentsHost,
} from '@nestjs/common';
import { AppException, ErrorCode } from '../errors/app.exception.js';
import type { ProblemDetailsDto } from '../errors/problem-details.dto.js';
import { ProblemDetailsFilter } from './problem-details.filter.js';

interface Captured {
  status?: number;
  type?: string;
  body?: ProblemDetailsDto;
  headers: Record<string, string>;
}

function run(exception: unknown, request: Record<string, unknown> = {}): Captured {
  const captured: Captured = { headers: {} };
  const response = {
    setHeader: (name: string, value: string) => {
      captured.headers[name] = value;
    },
    status: (status: number) => {
      captured.status = status;
      return response;
    },
    type: (type: string) => {
      captured.type = type;
      return response;
    },
    json: (body: ProblemDetailsDto) => {
      captured.body = body;
    },
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ id: 'req-12345678', method: 'GET', url: '/x', headers: {}, ...request }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;

  new ProblemDetailsFilter().catch(exception, host);
  return captured;
}

describe('ProblemDetailsFilter', () => {
  it('renders AppException with its stable code and field errors', () => {
    const result = run(
      new AppException(ErrorCode.ValidationFailed, HttpStatus.BAD_REQUEST, 'Bad input.', [
        { path: 'email', code: 'isEmail', message: 'email must be an email' },
      ]),
    );

    expect(result.status).toBe(400);
    expect(result.type).toBe('application/problem+json');
    expect(result.headers['X-Request-Id']).toBe('req-12345678');
    expect(result.body).toEqual({
      type: 'urn:fca:problem:validation-failed',
      title: 'Bad Request',
      status: 400,
      code: 'VALIDATION_FAILED',
      detail: 'Bad input.',
      errors: [{ path: 'email', code: 'isEmail', message: 'email must be an email' }],
      requestId: 'req-12345678',
    });
  });

  it('maps built-in HttpExceptions to a status-derived code', () => {
    const notFound = run(new NotFoundException('Cannot GET /nope'));
    expect(notFound.status).toBe(404);
    expect(notFound.body?.code).toBe('NOT_FOUND');
    expect(notFound.body?.detail).toBe('Cannot GET /nope');

    const badRequest = run(new BadRequestException(['a must be a string', 'b is required']));
    expect(badRequest.body?.code).toBe('BAD_REQUEST');
    expect(badRequest.body?.detail).toBe('a must be a string; b is required');
  });

  it('maps exposed middleware errors (e.g. body-parser) to 4xx problems', () => {
    const syntaxError = Object.assign(new SyntaxError('Unexpected token'), {
      status: 400,
      expose: true,
      type: 'entity.parse.failed',
    });
    const result = run(syntaxError);
    expect(result.status).toBe(400);
    expect(result.body?.code).toBe('BAD_REQUEST');
  });

  it('never leaks the message or stack of unexpected errors, but logs them with the request id', () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const result = run(new Error('connection string postgresql://user:secret@host/db failed'));

    expect(result.status).toBe(500);
    expect(result.body?.code).toBe('INTERNAL_ERROR');
    expect(result.body?.detail).toBe('An unexpected error occurred.');
    expect(JSON.stringify(result.body)).not.toContain('secret');
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0]?.[0])).toContain('req-12345678');
  });

  it('falls back to the inbound header, then a UUID, when the request has no id', () => {
    const fromHeader = run(new NotFoundException(), {
      id: undefined,
      headers: { 'x-request-id': 'inbound-id-1' },
    });
    expect(fromHeader.body?.requestId).toBe('inbound-id-1');

    const generated = run(new NotFoundException(), { id: undefined, headers: {} });
    expect(generated.body?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
