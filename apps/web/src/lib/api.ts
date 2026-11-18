import type { Page } from './types';

// The browser calls /api/v1 on its own origin; next.config.ts forwards it to the API server.
const BASE = '/api/v1';

export interface FieldError {
  path: string;
  message: string;
}

/** An error response from the API: { error: { code, message, details, requestId } }. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId: string | undefined;

  constructor(status: number, code: string, message: string, details?: unknown, requestId?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }

  /**
   * Validation errors keyed by field path without the request part:
   * "body.profile.gstin" becomes "profile.gstin".
   */
  get fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    if (this.code !== 'validation_failed' || !Array.isArray(this.details)) return out;
    for (const item of this.details) {
      if (!isRecord(item) || typeof item.path !== 'string' || typeof item.message !== 'string') continue;
      const key = item.path.replace(/^(body|query|params)\.?/, '');
      out[key] ??= item.message;
    }
    return out;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** Errors that mean the session changed under us: signed out, or a second step is now needed. */
export function isSessionError(error: unknown): boolean {
  return (
    isApiError(error) &&
    (error.status === 401 || error.code === 'mfa_required' || error.code === 'mfa_setup_required') &&
    error.code !== 'invalid_credentials' &&
    error.code !== 'invalid_code'
  );
}

/** Field errors from a failed request, keyed like "email" or "profile.gstin". */
export function fieldErrorsOf(error: unknown): Record<string, string> {
  return isApiError(error) ? error.fieldErrors : {};
}

/** The error to show above a form: anything that isn't already shown next to a field. */
export function formErrorOf(error: unknown, shownFields: readonly string[] = []): unknown {
  if (!error) return null;
  const fields = Object.keys(fieldErrorsOf(error));
  if (fields.length > 0 && fields.every((field) => shownFields.includes(field))) return null;
  return error;
}

export function errorMessage(error: unknown): string {
  if (isApiError(error)) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong. Please try again.';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type Query = Record<string, string | number | boolean | null | undefined>;

export function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

async function request(method: string, path: string, body?: unknown): Promise<unknown> {
  // The API refuses writes without this header, which a cross-site form can't send.
  const headers: Record<string, string> = { Accept: 'application/json', 'X-Phoenix-Client': 'web' };
  let payload: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(BASE + path, { method, headers, body: payload, credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw new ApiError(0, 'network_error', "Can't reach the server. Check your connection and try again.");
  }

  if (response.status === 204) return undefined;
  const text = await response.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  if (!response.ok) {
    const error = isRecord(json) && isRecord(json.error) ? json.error : {};
    throw new ApiError(
      response.status,
      typeof error.code === 'string' ? error.code : 'http_error',
      typeof error.message === 'string' ? error.message : `The server answered ${response.status}. Please try again.`,
      error.details,
      typeof error.requestId === 'string' ? error.requestId : undefined,
    );
  }
  return json;
}

function unwrap<T>(json: unknown): T {
  return (isRecord(json) ? json.data : undefined) as T;
}

export const api = {
  get: async <T>(path: string, query?: Query): Promise<T> => unwrap<T>(await request('GET', withQuery(path, query))),
  /** Cursor-paginated lists keep their envelope: { data, nextCursor }. */
  page: async <T>(path: string, query?: Query): Promise<Page<T>> =>
    (await request('GET', withQuery(path, query))) as Page<T>,
  post: async <T = void>(path: string, body?: unknown): Promise<T> => unwrap<T>(await request('POST', path, body)),
  put: async <T = void>(path: string, body?: unknown): Promise<T> => unwrap<T>(await request('PUT', path, body)),
  patch: async <T = void>(path: string, body?: unknown): Promise<T> => unwrap<T>(await request('PATCH', path, body)),
  delete: async (path: string, query?: Query): Promise<void> => {
    await request('DELETE', withQuery(path, query));
  },
};
