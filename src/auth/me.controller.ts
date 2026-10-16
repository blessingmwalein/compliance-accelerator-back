import { Controller, Get, HttpStatus, Req } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiProblemResponse } from '../common/errors/api-problem-response.decorator.js';
import { Authenticated } from './access.decorators.js';
import { MeDto } from './auth.dto.js';
import { AuthService } from './auth.service.js';
import type { AuthenticatedRequest } from './auth.guard.js';

@ApiTags('auth')
@Authenticated()
@Controller('me')
export class MeController {
  constructor(private readonly auth: AuthService) {}

  /** The signed-in user. The organisations they belong to: `GET /organisations`. */
  @Get()
  @ApiOperation({ operationId: 'getMe', summary: 'The signed-in user' })
  @ApiOkResponse({ type: MeDto, description: 'The signed-in user.' })
  @ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
  async getMe(@Req() request: AuthenticatedRequest): Promise<MeDto> {
    const user = await this.auth.getUser(request.auth.userId);
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      emailVerified: user.emailVerifiedAt !== null,
      isPlatformAdmin: user.isPlatformAdmin,
      createdAt: user.createdAt.toISOString(),
    };
  }
}
