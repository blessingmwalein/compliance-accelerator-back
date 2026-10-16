import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { API_VERSION, CONTRACT_VERSION } from '../../meta/contract-version.js';

/**
 * Builds the OpenAPI document that IS the HTTP contract. Paths are relative to the versioned
 * server URL (`/api/v1`), so clients configure one base URL and generated code stays prefix-free.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Fernando Compliance Accelerator API')
    .setDescription(
      'REST API for the Fernando Compliance Accelerator (FCA) platform. Errors use RFC 9457 ' +
        'problem+json with a stable `code`. Cross-framework mappings and assessments are ' +
        'informative aids and do not constitute legal advice.',
    )
    .setVersion(CONTRACT_VERSION)
    .addServer(`/api/${API_VERSION}`, 'Versioned API root')
    .build();

  return SwaggerModule.createDocument(app, config, {
    ignoreGlobalPrefix: true,
    // Default ids contain an underscore on purpose: every endpoint must declare its own
    // verb-first operationId (they become frontend hook names) and a test rejects the default.
    operationIdFactory: (controllerKey, methodKey) => `${controllerKey}_${methodKey}`,
  });
}

/** Serves Swagger UI at /api/docs and the raw document at /api/docs-json. */
export function setupSwaggerUi(app: INestApplication, document: OpenAPIObject): void {
  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: 'api/docs-json',
    customSiteTitle: 'FCA API',
  });
}
