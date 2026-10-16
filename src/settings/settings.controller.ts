import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Put,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { OrganisationMember, RequirePermission } from '../auth/access.decorators.js';
import { ApiProblemResponse } from '../common/errors/api-problem-response.decorator.js';
import { LogoUploadDto, OrganisationSettingsDto, UpdateSettingsDto } from './settings.dto.js';
import { MAX_LOGO_BYTES, SettingsService } from './settings.service.js';

/** Company Settings of the organisation in the path. Branding (display name, logo) is Company Owner only. */
@ApiTags('settings')
@ApiParam({ name: 'organisationId', type: String, format: 'uuid' })
@ApiProblemResponse(HttpStatus.UNAUTHORIZED, 'Not signed in, or the session ended.')
@ApiProblemResponse(HttpStatus.FORBIDDEN, "The caller's role does not allow this action.")
@ApiProblemResponse(
  HttpStatus.NOT_FOUND,
  'Not a member of this organisation (or it does not exist).',
)
@Controller('organisations/:organisationId/settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @RequirePermission('company.view')
  @ApiOperation({ operationId: 'getSettings', summary: 'Company settings' })
  @ApiOkResponse({ type: OrganisationSettingsDto })
  get(): Promise<OrganisationSettingsDto> {
    return this.settings.get();
  }

  /** Changes company information and the DPO contact. Changing the display name also needs the branding permission. */
  @Patch()
  @RequirePermission('company.edit')
  @ApiOperation({ operationId: 'updateSettings', summary: 'Change company settings' })
  @ApiOkResponse({ type: OrganisationSettingsDto })
  @ApiProblemResponse(HttpStatus.BAD_REQUEST, 'Validation failed.')
  @ApiProblemResponse(HttpStatus.CONFLICT, '`VERSION_CONFLICT`: changed by someone else.')
  update(@Body() dto: UpdateSettingsDto): Promise<OrganisationSettingsDto> {
    return this.settings.update(dto);
  }

  /** Uploads the logo: a PNG or JPEG up to 512 KiB, checked by its bytes. Replaces the previous logo. */
  @Put('logo')
  @RequirePermission('company.branding')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_LOGO_BYTES, files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: LogoUploadDto })
  @ApiOperation({ operationId: 'uploadLogo', summary: 'Upload the company logo' })
  @ApiOkResponse({ type: OrganisationSettingsDto })
  @ApiProblemResponse(HttpStatus.PAYLOAD_TOO_LARGE, 'The file is larger than 512 KiB.')
  @ApiProblemResponse(HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'The file is not a PNG or JPEG image.')
  uploadLogo(
    @UploadedFile() file: { buffer?: Buffer } | undefined,
  ): Promise<OrganisationSettingsDto> {
    return this.settings.uploadLogo(file?.buffer);
  }

  /** The logo image, for any member of the organisation (it is part of how the organisation is shown). */
  @Get('logo')
  @OrganisationMember()
  @ApiOperation({ operationId: 'downloadLogo', summary: 'The company logo image' })
  @ApiProduces('image/png', 'image/jpeg')
  @ApiOkResponse({ description: 'The image bytes.', schema: { type: 'string', format: 'binary' } })
  @ApiProblemResponse(HttpStatus.NOT_FOUND, 'No logo has been uploaded.')
  async downloadLogo(@Req() request: Request, @Res() response: Response): Promise<void> {
    const logo = await this.settings.downloadLogo();
    const etag = `"${logo.sha256}"`;
    response.setHeader('ETag', etag);
    // private: it is served to signed-in members only; the browser revalidates instead of trusting a stale copy
    response.setHeader('Cache-Control', 'private, no-cache');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'");
    if (request.headers['if-none-match'] === etag) {
      response.status(HttpStatus.NOT_MODIFIED).end();
      return;
    }
    response.setHeader('Content-Type', logo.contentType);
    response.setHeader('Content-Length', String(logo.data.length));
    response.status(HttpStatus.OK).end(logo.data);
  }

  @Delete('logo')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('company.branding')
  @ApiOperation({ operationId: 'removeLogo', summary: 'Remove the company logo' })
  @ApiNoContentResponse({ description: 'The logo was removed (or there was none).' })
  removeLogo(): Promise<void> {
    return this.settings.removeLogo();
  }
}
