import { HttpStatus, ValidationPipe, type ValidationError } from '@nestjs/common';
import { AppException, ErrorCode, type FieldError } from '../errors/app.exception.js';

/** Flattens nested class-validator errors into `{ path, code, message }` entries (dot-notation paths). */
export function flattenValidationErrors(errors: ValidationError[], parent = ''): FieldError[] {
  return errors.flatMap((error) => {
    const path = parent ? `${parent}.${error.property}` : error.property;
    const own = Object.entries(error.constraints ?? {}).map(([code, message]) => ({
      path,
      code,
      message,
    }));
    return [...own, ...flattenValidationErrors(error.children ?? [], path)];
  });
}

/**
 * Global validation pipe. `whitelist` + `forbidNonWhitelisted` reject unknown properties, which is
 * the first line of defence against mass assignment (e.g. a client sending `organisationId`).
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    exceptionFactory: (errors: ValidationError[]) =>
      new AppException(
        ErrorCode.ValidationFailed,
        HttpStatus.BAD_REQUEST,
        'Request validation failed.',
        flattenValidationErrors(errors),
      ),
  });
}
