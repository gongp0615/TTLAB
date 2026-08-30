import { isLogType, type LogQueryOptions, type LogType } from './types.js';

const MAX_LIMIT = 1000;
const MAX_OFFSET = 100_000;

export class QueryParamError extends Error {}

function parseNonNegativeInt(value: string | null, label: string): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new QueryParamError(`${label} must be a non-negative integer`);
  return parsed;
}

function parseTimestamp(value: string | null, label: string): string | undefined {
  if (value === null) return undefined;
  if (!Number.isFinite(Date.parse(value))) throw new QueryParamError(`${label} must be a valid ISO 8601 timestamp`);
  return value;
}

export function parseLogQuery(search: URLSearchParams): LogQueryOptions {
  const rawTypes = search.getAll('type');
  if (rawTypes.some((value) => !isLogType(value))) throw new QueryParamError('type must be one of device, event, command, audit, agent, error');
  const types: LogType[] = rawTypes.length > 0 ? (rawTypes as LogType[]) : ['device'];
  const options: LogQueryOptions = { types };
  for (const field of ['clientId', 'deviceId', 'commandId', 'actor', 'sessionId'] as const) {
    const value = search.get(field);
    if (value !== null && value.trim().length > 0) options[field] = value.trim();
  }
  const from = parseTimestamp(search.get('from'), 'from');
  if (from !== undefined) options.from = from;
  const to = parseTimestamp(search.get('to'), 'to');
  if (to !== undefined) options.to = to;
  const keyword = search.get('keyword');
  if (keyword !== null && keyword.trim().length > 0) options.keyword = keyword.trim();
  const limit = parseNonNegativeInt(search.get('limit'), 'limit');
  if (limit !== undefined) {
    if (limit === 0 || limit > MAX_LIMIT) throw new QueryParamError(`limit must be between 1 and ${MAX_LIMIT}`);
    options.limit = limit;
  }
  const offset = parseNonNegativeInt(search.get('offset'), 'offset');
  if (offset !== undefined) {
    if (offset > MAX_OFFSET) throw new QueryParamError(`offset must not exceed ${MAX_OFFSET}`);
    options.offset = offset;
  }
  return options;
}

export function parseAuditQuery(search: URLSearchParams): LogQueryOptions {
  const options = parseLogQuery(search);
  options.types = ['audit'];
  return options;
}
