/**
 * Express 4 does not catch rejected promises from route handlers: a handler
 * that throws asynchronously leaves the request hanging until the client
 * times out. Every database call is now async, so that would be the default
 * behaviour rather than an edge case.
 *
 * `asyncRouter` wraps the registration methods instead of the handlers, so a
 * route file keeps reading like ordinary Express and a failure is forwarded to
 * the error middleware either way.
 */

import { Router } from 'express';

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all', 'use'];

export function asyncRouter() {
  const router = Router();
  for (const method of METHODS) {
    const original = router[method].bind(router);
    router[method] = (...args) => {
      // Only the handler argument needs wrapping; middleware that is already
      // a function taking (req, res, next) is fine either way.
      const last = args.length - 1;
      const handler = args[last];
      if (typeof handler !== 'function' || handler.length >= 4) {
        return original(...args);
      }
      args[last] = (req, res, next) => {
        try {
          const out = handler(req, res, next);
          if (out && typeof out.catch === 'function') out.catch(next);
        } catch (err) {
          next(err);
        }
      };
      return original(...args);
    };
  }
  return router;
}
