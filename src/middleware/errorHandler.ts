import type { NextFunction, Request, Response } from 'express';

/** Domain error carrying an HTTP status code. */
export class HttpError extends Error {
  public readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: 'Not found' });
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  // multer surfaces upload problems (e.g. file too large) as MulterError.
  if (typeof err === 'object' && err !== null && (err as { name?: string }).name === 'MulterError') {
    res.status(400).json({ error: `Upload error: ${(err as Error).message}` });
    return;
  }
  // eslint-disable-next-line no-console
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
}
