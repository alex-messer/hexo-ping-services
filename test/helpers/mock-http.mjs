import { createServer } from 'node:http';

export function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks).toString('utf8');
      const reply = await handler({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(reply.status, reply.headers || { 'content-type': 'application/json' });
      res.end(reply.body ?? '');
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise(r => server.close(r))
      });
    });
  });
}
