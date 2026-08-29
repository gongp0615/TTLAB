export function validateSchema(value: unknown, schema: Record<string, unknown>): string | undefined {
  const type = schema.type as string | undefined;
  if (type === 'object' || schema.properties !== undefined) return validateObject(value, schema);
  if (type === 'array') return validateArray(value, schema);
  if (type === 'string') return validateString(value, schema);
  if (type === 'integer') return validateNumber(value, schema, true);
  if (type === 'number') return validateNumber(value, schema, false);
  if (type === 'boolean') return typeof value === 'boolean' ? undefined : 'expected boolean';
  return undefined;
}

function validateObject(value: unknown, schema: Record<string, unknown>): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'expected object';
  const record = value as Record<string, unknown>;
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  if (Array.isArray(schema.required)) {
    for (const name of schema.required) {
      if (typeof name !== 'string' || !(name in record)) return `missing required field "${String(name)}"`;
    }
  }
  for (const [name, property] of Object.entries(properties)) {
    if (record[name] === undefined) continue;
    const error = validateSchema(record[name], property);
    if (error !== undefined) return `${name}: ${error}`;
  }
  if (schema.additionalProperties === false) {
    for (const name of Object.keys(record)) {
      if (!(name in properties)) return `unknown field "${name}"`;
    }
  }
  return undefined;
}

function validateArray(value: unknown, schema: Record<string, unknown>): string | undefined {
  if (!Array.isArray(value)) return 'expected array';
  const itemSchema = schema.items as Record<string, unknown> | undefined;
  if (itemSchema === undefined) return undefined;
  for (let index = 0; index < value.length; index += 1) {
    const error = validateSchema(value[index], itemSchema);
    if (error !== undefined) return `item ${index}: ${error}`;
  }
  return undefined;
}

function validateString(value: unknown, schema: Record<string, unknown>): string | undefined {
  if (typeof value !== 'string') return 'expected string';
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return `expected one of ${schema.enum.join(', ')}`;
  return undefined;
}

function validateNumber(value: unknown, schema: Record<string, unknown>, integer: boolean): string | undefined {
  if (typeof value !== 'number') return 'expected number';
  if (integer && !Number.isInteger(value)) return 'expected integer';
  if (typeof schema.minimum === 'number' && value < schema.minimum) return `must be >= ${schema.minimum}`;
  if (typeof schema.maximum === 'number' && value > schema.maximum) return `must be <= ${schema.maximum}`;
  return undefined;
}
