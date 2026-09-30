/**
 * Vercel serverless entry point.
 *
 * Vercel treats everything in /api as a function and invokes the default
 * export with the original request URL intact, so the same Express app that
 * `npm start` serves locally also answers /api/* in production.
 *
 * Static assets are not served from here: vercel.json points Vercel's CDN at
 * ./public, which keeps the function bundle small and the app fast.
 */
import app from '../server/app.js';

export default app;
