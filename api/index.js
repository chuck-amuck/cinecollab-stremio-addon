'use strict';

// Vercel serverless entry point. vercel.json rewrites all routes here.
const handler = require('../handler');

module.exports = function (req, res) {
  return handler(req, res);
};
