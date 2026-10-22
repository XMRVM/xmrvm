export class InputError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = 'InputError';
  }
}

export function amount(value: unknown, field = 'amount', allowZero = false): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value)) {
    throw new InputError('INVALID_AMOUNT', `${field} must be a canonical decimal integer string`);
  }
  const parsed = BigInt(value);
  if ((!allowZero && parsed === 0n) || parsed > (1n << 256n) - 1n) {
    throw new InputError('INVALID_AMOUNT', `${field} is outside the allowed range`);
  }
  return parsed;
}

export function label(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9:_-]{1,96}$/.test(value)) {
    throw new InputError('INVALID_LABEL', `${field} must contain 1-96 letters, digits, :, _ or -`);
  }
  return value;
}
