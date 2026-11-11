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
  // TEMPORARY diagnostic (remove once routing is confirmed): with request header
  // x-cc-debug: 1, report what Vercel handed this function.
  if (req.headers['x-cc-debug'] === '1') {
    const h = {};
    for (const k of Object.keys(req.headers)) {
      if (/^(x-matched-path|x-now-route-matches|x-vercel-[a-z-]*path[a-z-]*|x-forwarded-(uri|path|prefix)|x-original-[a-z-]*|x-invoke-[a-z-]*)$/.test(k)) h[k] = req.headers[k];
    }
    res.setHeader('x-cc-seen', JSON.stringify({ url: req.url, headers: h, names: Object.keys(req.headers).filter(k => k.startsWith('x-')) }));
  }
  req.url = originalUrl(req.url || '/');
  return handler(req, res);
};

module.exports.originalUrl = originalUrl;
