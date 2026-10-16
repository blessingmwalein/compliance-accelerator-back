import { Controller, Get, HttpStatus } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/access.decorators.js';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import { ApiProblemResponse } from '../common/errors/api-problem-response.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { HealthDto, ReadyDto } from './health.dto.js';

@ApiTags('system')
@Public()
@SkipThrottle() // probes poll often and must never be rate limited
@Controller('health')
export class HealthController {
  // Health probes are the one non-repository consumer of PrismaService (see backend-architecture skill).
  constructor(private readonly prisma: PrismaService) {}

  /** Liveness: answers 200 while the process is running. Does not touch dependencies. */
  @Get()
  @ApiOperation({ operationId: 'getHealth', summary: 'Liveness probe' })
  @ApiOkResponse({ type: HealthDto, description: 'The process is running.' })
  getHealth(): HealthDto {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  /** Readiness: 200 only when the database answers `SELECT 1`; otherwise 503 problem+json. */
  @Get('ready')
  @ApiOperation({ operationId: 'getReadiness', summary: 'Readiness probe (database reachable)' })
  @ApiOkResponse({ type: ReadyDto, description: 'All dependencies are reachable.' })
  @ApiProblemResponse(
    HttpStatus.SERVICE_UNAVAILABLE,
    'A dependency is not configured or not reachable.',
  )
  async getReadiness(): Promise<ReadyDto> {
    const database = await this.prisma.ping();

    if (database === 'not_configured') {
      throw new AppException(
        ErrorCode.DatabaseNotConfigured,
        HttpStatus.SERVICE_UNAVAILABLE,
        'DATABASE_URL is not configured.',
      );
    }
    if (database === 'down') {
      throw new AppException(
        ErrorCode.DatabaseUnavailable,
        HttpStatus.SERVICE_UNAVAILABLE,
        'The database is not reachable.',
      );
    }

    return { status: 'ok', checks: { database } };
  }
}
