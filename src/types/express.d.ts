import type { AuthUser, AccessScope } from './index';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      accessScope?: AccessScope;
    }
  }
}

export {};
