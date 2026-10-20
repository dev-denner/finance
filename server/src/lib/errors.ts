export interface ApiIssue {
  path?: string;
  message: string;
}

export class HttpError extends Error {
  statusCode: number;
  issues?: ApiIssue[];

  constructor(statusCode: number, message: string, issues?: ApiIssue[]) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.issues = issues;
  }
}

export function badRequest(message: string, issues?: ApiIssue[]): HttpError {
  return new HttpError(400, message, issues);
}

export function notFound(message: string): HttpError {
  return new HttpError(404, message);
}

export function conflict(message: string, issues?: ApiIssue[]): HttpError {
  return new HttpError(409, message, issues);
}

export function nowIso(): string {
  return new Date().toISOString();
}
