import { applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';
import { ProblemDetailsDto } from './problem-details.dto.js';

/**
 * Documents an error response as RFC 9457 `application/problem+json` (what ProblemDetailsFilter
 * actually returns). Use it for every non-2xx status an endpoint can produce.
 */
export function ApiProblemResponse(
  status: number,
  description: string,
): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ApiExtraModels(ProblemDetailsDto),
    ApiResponse({
      status,
      description,
      content: {
        'application/problem+json': { schema: { $ref: getSchemaPath(ProblemDetailsDto) } },
      },
    }),
  );
}
