'use strict';

const { lookupAccessToken } = require('../store/access-tokens');

/**
 * Express middleware. Lets a request through only when it carries a known,
 * unrevoked bearer token whose scopes cover the route.
 */
function requireAuth(requiredScope) {
  return async function (req, res, next) {
    const header = req.get('authorization') || '';
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) {
      res.status(401).json({ error: 'missing_bearer_token' });
      return;
    }

    const record = await lookupAccessToken(match[1]);
    if (!record || record.revokedAt) {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }
    if (record.expiresAt.getTime() <= Date.now()) {
      res.status(401).json({ error: 'token_expired' });
      return;
    }
    if (requiredScope && !record.scopes.includes(requiredScope)) {
      res.status(403).json({ error: 'insufficient_scope' });
      return;
    }

    req.principal = { userId: record.userId, scopes: record.scopes };
    next();
  };
}

module.exports = { requireAuth };
