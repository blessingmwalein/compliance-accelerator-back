import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../auth/access.decorators.js';
import { ApiProblemResponse } from '../common/errors/api-problem-response.decorator.js';
import { PageQueryDto } from '../common/pagination.js';
import { ChangeRoleDto, MemberDto, MemberPageDto, MemberVersionDto } from './members.dto.js';
import { MembersService } from './members.service.js';

@ApiTags('members')
@ApiParam({ name: 'organisationId', type: String, format: 'uuid' })
@ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
@ApiProblemResponse(HttpStatus.FORBIDDEN, "The caller's role does not allow this action.")
@ApiProblemResponse(
  HttpStatus.NOT_FOUND,
  'Not a member of this organisation, or the member does not exist.',
)
@Controller('organisations/:organisationId/members')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  @RequirePermission('users.view')
  @ApiOperation({ operationId: 'listMembers', summary: 'List the organisation members' })
  @ApiOkResponse({ type: MemberPageDto })
  list(@Query() query: PageQueryDto): Promise<MemberPageDto> {
    return this.members.list(query);
  }

  /** Changes a member's role. Only an Owner may grant, change or remove the Owner role; nobody changes their own role. */
  @Patch(':membershipId')
  @RequirePermission('users.edit')
  @ApiOperation({ operationId: 'changeMemberRole', summary: "Change a member's role" })
  @ApiOkResponse({ type: MemberDto })
  @ApiProblemResponse(
    HttpStatus.CONFLICT,
    '`VERSION_CONFLICT` (changed by someone else) or `LAST_OWNER`.',
  )
  changeRole(
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @Body() dto: ChangeRoleDto,
  ): Promise<MemberDto> {
    return this.members.changeRole(membershipId, dto);
  }

  /** Removes a member's access (the history stays). Company Owner only. The last Owner cannot be deactivated. */
  @Post(':membershipId/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('users.delete')
  @ApiOperation({ operationId: 'deactivateMember', summary: 'Deactivate a member' })
  @ApiOkResponse({ type: MemberDto })
  @ApiProblemResponse(
    HttpStatus.CONFLICT,
    '`VERSION_CONFLICT` (changed by someone else) or `LAST_OWNER`.',
  )
  deactivate(
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @Body() dto: MemberVersionDto,
  ): Promise<MemberDto> {
    return this.members.deactivate(membershipId, dto);
  }

  @Post(':membershipId/reactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('users.delete')
  @ApiOperation({ operationId: 'reactivateMember', summary: 'Reactivate a deactivated member' })
  @ApiOkResponse({ type: MemberDto })
  @ApiProblemResponse(HttpStatus.CONFLICT, '`VERSION_CONFLICT`: changed by someone else.')
  reactivate(
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @Body() dto: MemberVersionDto,
  ): Promise<MemberDto> {
    return this.members.reactivate(membershipId, dto);
  }
}
