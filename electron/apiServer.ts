import type { Server } from 'node:http';
import { createApiServer } from '../server/index.js';

let server: Server | undefined;
export function startLocalApi(port = Number(process.env.API_PORT ?? 4317)) {
  if (server) return server;
  server = createApiServer().listen(port, '0.0.0.0');
  return server;
}
