'use strict';

// Vercel serverless entry point. vercel.json rewrites all routes here; the
// handler restores the client's original URL itself (see originalUrl there).
const handler = require('../handler');

module.exports = function (req, res) {
  return handler(req, res);
};
