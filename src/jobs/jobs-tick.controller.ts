import { Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../auth/access.decorators.js';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import type { EnvironmentVariables } from '../config/env.schema.js';
import { JobRunner, type RunSummary } from './job-runner.service.js';
import { TICK_SIGNATURE_HEADER, TICK_TIMESTAMP_HEADER, verifyTick } from './tick-signature.js';

/**
 * Lets a host scheduler (cron, a serverless scheduler) drive the job runner when no process stays
 * alive (ADR-0006). It is public in the JWT sense but requires an HMAC-signed request, processes one
 * bounded batch and returns counts only. It is an operational endpoint, not part of the client
 * contract, so it is excluded from OpenAPI (documented in docs/integration.md).
 */
@ApiExcludeController()
@Controller('internal/jobs')
export class JobsTickController {
  private readonly secret: string | undefined;

  constructor(
    private readonly runner: JobRunner,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.secret = config.get('JOBS_TICK_SECRET', { infer: true }) || undefined;
  }

  @Public()
  @Post('tick')
  @HttpCode(HttpStatus.OK)
  async tick(@Req() request: Request): Promise<RunSummary> {
    // Without a configured secret the endpoint does not exist as far as callers can tell.
    if (!this.secret)
      throw new AppException(ErrorCode.NotFound, HttpStatus.NOT_FOUND, 'Not found.');

    const valid = verifyTick({
      secret: this.secret,
      timestamp: header(request, TICK_TIMESTAMP_HEADER),
      signature: header(request, TICK_SIGNATURE_HEADER),
      now: new Date(),
    });
    if (!valid)
      throw new AppException(
        ErrorCode.Unauthenticated,
        HttpStatus.UNAUTHORIZED,
        'Invalid signature.',
      );

    return this.runner.runBatch();
  }
}

function header(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
