import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/access.decorators.js';
import type { EnvironmentVariables } from '../config/env.schema.js';
import { readAppInfo } from './app-info.js';
import { API_VERSION, CONTRACT_VERSION } from './contract-version.js';
import { MetaDto } from './meta.dto.js';

@ApiTags('system')
@Public()
@Controller('meta')
export class MetaController {
  constructor(private readonly config: ConfigService<EnvironmentVariables, true>) {}

  /** Returns the build version and the HTTP contract version this server implements. */
  @Get()
  @ApiOperation({ operationId: 'getMeta', summary: 'Build and contract information' })
  @ApiOkResponse({ type: MetaDto, description: 'Build and contract versions.' })
  getMeta(): MetaDto {
    const { name, version } = readAppInfo();
    return {
      name,
      version,
      contractVersion: CONTRACT_VERSION,
      apiVersion: API_VERSION,
      organisationSelfServe: this.config.get('ORGANISATIONS_SELF_SERVE', { infer: true }) === true,
      evidenceMaxBytes: this.config.get('EVIDENCE_MAX_BYTES', { infer: true }),
    };
  }
}
