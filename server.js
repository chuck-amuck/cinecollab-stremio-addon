'use strict';

// Local self-host server. Run with: node server.js
const http = require('http');
const handler = require('./handler');

const PORT = process.env.PORT || 7860;

http.createServer(handler).listen(PORT, function () {
  console.log('CineCollab addon running on http://127.0.0.1:' + PORT);
  console.log('Open http://127.0.0.1:' + PORT + '/configure to get your install link.');
});
