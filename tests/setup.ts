import dotenv from 'dotenv';

// Load .env (or .env.test if present) so the pg pool and JWT helpers are
// configured before any test module imports the app.
dotenv.config({ path: process.env.TEST_ENV_FILE ?? '.env' });

if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'test-secret';
}
