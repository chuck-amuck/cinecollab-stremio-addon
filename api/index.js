'use strict';

// Vercel serverless entry point. vercel.json rewrites every path here as
// /api/index?__path=/<original path>, because a Vercel rewrite hands the
// function its destination URL rather than the one the client asked for
// (a June 2026 build of this code worked; the same code built on 2026-11-10
// saw every addon URL as /api/index and answered 404). originalUrl() puts the
// client's URL back before the shared handler sees it. server.js runs the
// handler directly, without this.
const handler = require('../handler');

function originalUrl(reqUrl) {
  const q = reqUrl.indexOf('?');
  if (q < 0) return reqUrl;
  const parts = reqUrl.slice(q + 1).split('&');
  const at = parts.findIndex(p => p === '__path' || p.startsWith('__path='));
  if (at < 0) return reqUrl;

  let path = parts[at].slice('__path='.length) || '/';
  // An encoded path has no literal '/' after the leading one we add ourselves.
  if (!path.slice(1).includes('/') && /%2F/i.test(path)) path = decodeURIComponent(path);
  if (!path.startsWith('/')) path = '/' + path;

  const rest = parts.filter((_, i) => i !== at && parts[i] !== '');
  // Stremio puts catalog extras in the last path segment ("genre=X&skip=20.json")
  // and never sends a query string. If the path went into the query unencoded,
  // its '&' split those extras off into separate parameters: join them back.
  if (rest.length && /\/catalog\//.test(path) && !path.endsWith('.json')) {
    return path + '&' + rest.join('&');
  }
  return rest.length ? path + '?' + rest.join('&') : path;
}

module.exports = function (req, res) {
  req.url = originalUrl(req.url || '/');
  return handler(req, res);
};

module.exports.originalUrl = originalUrl;
