'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

/** Petit serveur HTTP local pour les tests. routes : { '/chemin': (req, res) => {} } */
function serve(routes) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const h = routes[req.url];
      if (!h) {
        res.writeHead(404);
        return res.end();
      }
      h(req, res);
    });
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({ base, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

module.exports = { serve, sha256 };
