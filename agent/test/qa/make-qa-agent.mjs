// QA harness: builds qa-agent.gen.mjs, a copy of agent.mjs whose only change is a command-file hook (QA_CMD)
// that can feed many scripted turns (agent.mjs's MENTOR_TEST_TURN supports just one). Product code is untouched.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
const agentDir = fileURLToPath(new URL('../../', import.meta.url));
let src = readFileSync(`${agentDir}agent.mjs`, 'utf8');
src = src.replace(/from '\.\/([\w-]+\.mjs)'/g, (_, f) => `from '${pathToFileURL(agentDir + f).href}'`);
src = src.replace("new URL('../runs/', import.meta.url)", `new URL('${pathToFileURL(agentDir + '../runs/').href}')`);
src = src.replace("new URL('.', import.meta.url)", `new URL('${pathToFileURL(agentDir).href}')`);
const start = src.indexOf('if (TEST_TURN) {');
const end = src.indexOf('if (session) await session.start');
if (start < 0 || end < 0) throw new Error('hook anchors not found');
const hook = `{
      const { readFileSync: rf, existsSync } = await import('node:fs');
      let done = 0;
      const poll = setInterval(() => {
        if (!process.env.QA_CMD || !existsSync(process.env.QA_CMD)) return;
        const lines = rf(process.env.QA_CMD, 'utf8').split('\\n').filter(Boolean);
        while (done < lines.length) { const l = lines[done++]; console.log('[qa] turn: ' + l); void onTurn(l).catch(e => console.error('[mentor] turn failed', e?.message || e)); }
      }, 100);
      ctx.addShutdownCallback(async () => clearInterval(poll));
    }

    `;
src = src.slice(0, start) + hook + src.slice(end);
writeFileSync(new URL('./qa-agent.gen.mjs', import.meta.url), src);
console.log('wrote qa-agent.gen.mjs');
