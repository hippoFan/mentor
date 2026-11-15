// QA: startLive() on a busy port should be a no-op per its doc comment ("never throws"). Occupy 8794, then call it.
import { createServer } from 'node:http';
process.env.MENTOR_MONITOR_PORT = '8794';
const blocker = createServer().listen(8794, '127.0.0.1');
await new Promise(r => blocker.once('listening', r));
process.on('uncaughtException', e => { console.log('UNCAUGHT:', e.code, e.message); blocker.close(); process.exit(3); });
const { startLive } = await import('../../live.mjs');
const live = await startLive();
console.log('startLive returned; send ok?', typeof live.send);
blocker.close(); process.exit(0);
