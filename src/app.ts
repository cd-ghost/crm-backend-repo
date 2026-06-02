import express from 'express';
import type { Application, Request, Response } from 'express';
import { authRouter } from './routes/auth';
import { usersRouter } from './routes/users';
import { leadsRouter } from './routes/leads';
import { dealsRouter } from './routes/deals';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';

/** Build and configure the Express application (no network listening). */
export function createApp(): Application {
  const app = express();

  app.use(express.json());

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/leads', leadsRouter);
  app.use('/api/deals', dealsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
