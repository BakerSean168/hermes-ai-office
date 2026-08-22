import { buildControlPlane } from './app.js';

const runtime = await buildControlPlane();
await runtime.app.listen({ host: runtime.host, port: runtime.port });
