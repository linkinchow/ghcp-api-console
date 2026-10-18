import { installGracefulShutdown } from '@ghcp/shared';
import { buildApp } from './app.js';
import { config } from './config.js';

const server = buildApp().listen(config.port, () => {
  console.log(`[console] listening on http://localhost:${config.port}`);
});
installGracefulShutdown({ server, service: 'console' });
