import type { ValidationError } from '@nestjs/common';
import { flattenValidationErrors } from './validation.pipe.js';

describe('flattenValidationErrors', () => {
  it('turns constraints into path/code/message entries', () => {
    const errors: ValidationError[] = [
      {
        property: 'email',
        constraints: { isEmail: 'email must be an email', isNotEmpty: 'email should not be empty' },
      },
    ];
    expect(flattenValidationErrors(errors)).toEqual([
      { path: 'email', code: 'isEmail', message: 'email must be an email' },
      { path: 'email', code: 'isNotEmpty', message: 'email should not be empty' },
    ]);
  });

  it('uses dot-notation paths for nested objects and array items', () => {
    const errors: ValidationError[] = [
      {
        property: 'contacts',
        children: [
          { property: '0', children: [{ property: 'email', constraints: { isEmail: 'bad' } }] },
        ],
      },
    ];
    expect(flattenValidationErrors(errors)).toEqual([
      { path: 'contacts.0.email', code: 'isEmail', message: 'bad' },
    ]);
  });
});
