// Argos refinement: edit a design as OpenSCAD code with an AI agent, then compile it to prove it still builds.
//   single     one developer call, compiled, and one automatic fix if OpenSCAD reports an error
//   multicode  a manager plans, a researcher gathers the facts, a developer writes the code, OpenSCAD compiles it,
//              an auditor checks it against the plan, the developer fixes what the auditor found (up to 2 rounds),
//              and the manager signs off. Each step is reported live through onProgress.
// Model output is untrusted: code goes through checkScad/compileScad (no file access, time-limited), text is capped.
//
//   await refine({ code, instruction, design, mode: 'multicode', provider: 'gemini', onProgress })
//     -> {ok, code, stl, summary, caveats, steps, calls, ms, provider}
import { complete } from './providers.mjs';
import { checkScad, compileScad } from './scad.mjs';

export const ROLES = ['manager', 'researcher', 'developer', 'auditor'];
export const MODES = ['single', 'multicode'];
const MAX_ROUNDS = 2;
const cap = (s, n) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const list = (a, k, n) => (Array.isArray(a) ? a : []).slice(0, k).map(x => cap(x, n)).filter(Boolean);

const RULES = `OpenSCAD rules: millimetres; keep one module per part with the existing module names unless the request
renames or removes a part; no include, use, import or surface; $fn at most 96; the file must end by calling the top-level
assembly. Change only what the request asks for and keep everything else exactly as it was.`;

const DEV_SCHEMA = { type: 'object', additionalProperties: false, required: ['code', 'summary'],
  properties: { code: { type: 'string' }, summary: { type: 'string' } } };
const PLAN_SCHEMA = { type: 'object', additionalProperties: false, required: ['goal', 'acceptance', 'questions', 'steps'],
  properties: { goal: { type: 'string' }, acceptance: { type: 'array', items: { type: 'string' } },
    questions: { type: 'array', items: { type: 'string' } }, steps: { type: 'array', items: { type: 'string' } } } };
const RESEARCH_SCHEMA = { type: 'object', additionalProperties: false, required: ['facts', 'unsure'],
  properties: { facts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['fact', 'value'],
    properties: { fact: { type: 'string' }, value: { type: 'string' } } } }, unsure: { type: 'array', items: { type: 'string' } } } };
const AUDIT_SCHEMA = { type: 'object', additionalProperties: false, required: ['pass', 'issues', 'fix'],
  properties: { pass: { type: 'boolean' }, issues: { type: 'array', items: { type: 'string' } }, fix: { type: 'string' } } };
const SIGNOFF_SCHEMA = { type: 'object', additionalProperties: false, required: ['summary', 'caveats'],
  properties: { summary: { type: 'string' }, caveats: { type: 'array', items: { type: 'string' } } } };

const designLine = d => d ? `The design: ${cap(d.name, 60) || 'unnamed'}${d.parts?.length ? `, parts: ${list(d.parts, 40, 40).join(', ')}` : ''}.` : '';

/**
 * @param {{code: string, instruction: string, design?: {name?: string, parts?: string[]}, mode?: string, provider?: string,
 *   onProgress?: (p: {role: string, state: 'working'|'done'|'failed', text: string}) => void}} req
 */
export async function refine({ code, instruction, design, mode = 'single', provider, onProgress = () => {} }) {
  const t0 = Date.now();
  const start = checkScad(code);
  const ask = cap(instruction, 600);
  if (!start.ok) return { ok: false, error: `The starting code is not usable: ${start.error}` };
  if (!ask) return { ok: false, error: 'Say what to change.' };
  let calls = 0, used = provider;
  const steps = [];
  const step = (role, state, text) => { const s = { role, state, text: cap(text, 300) }; steps.push(s); try { onProgress(s); } catch { /* page gone */ } };
  const call = async (system, prompt, schema) => { calls++; const r = await complete({ provider, system, prompt, schema, timeout: 90_000 }); used = r.provider; return r.data; };

  const develop = async (extra, current) => {
    const r = await call(`You are the developer on Ody's CAD team. You edit OpenSCAD code. ${RULES}`,
      `${designLine(design)}\nRequest: ${ask}\n${extra}\nCurrent code:\n${current}\n\nReturn the complete new file in "code" and one short sentence in "summary".`, DEV_SCHEMA);
    return { code: String(r.code || ''), summary: cap(r.summary, 200) };
  };
  const build = async (src, label) => {
    const chk = checkScad(src);
    if (!chk.ok) return { ok: false, code: src, error: chk.error };
    step('developer', 'working', `Compiling ${label} with OpenSCAD…`);
    const c = await compileScad(chk.code);
    return { ...c, code: chk.code };
  };

  try {
    if (!MODES.includes(mode) || mode === 'single') {
      step('developer', 'working', 'Editing the code…');
      let d = await develop('', start.code);
      let b = await build(d.code, 'the change');
      if (!b.ok) {
        step('developer', 'working', `OpenSCAD found a problem; fixing it: ${b.error}`);
        d = await develop(`Your last attempt failed in OpenSCAD with: ${b.error}\nFix that.`, d.code || start.code);
        b = await build(d.code, 'the fix');
      }
      if (!b.ok) { step('developer', 'failed', b.error); return { ok: false, error: b.error, code: b.code, steps, calls, ms: Date.now() - t0, provider: used }; }
      step('developer', 'done', d.summary || 'Done.');
      return { ok: true, code: b.code, stl: b.stl, summary: d.summary, caveats: [], steps, calls, ms: Date.now() - t0, provider: used };
    }

    // ---- multicode ----
    step('manager', 'working', 'Planning the change…');
    const plan = await call('You are the manager of a small CAD team (researcher, developer, auditor) editing an OpenSCAD design. Plan; do not write code.',
      `${designLine(design)}\nRequest: ${ask}\nCode:\n${start.code}\n\nGive the goal, 2-5 checkable acceptance criteria, 0-4 factual questions the researcher should answer (real-world dimensions, standards, clearances), and 2-5 steps.`, PLAN_SCHEMA);
    const acceptance = list(plan.acceptance, 5, 160), questions = list(plan.questions, 4, 160);
    step('manager', 'done', cap(plan.goal, 200) || ask);

    let facts = [], unsure = [];
    if (questions.length) {
      step('researcher', 'working', `Looking up: ${questions.join('; ')}`);
      const r = await call('You are the researcher on a CAD team. Answer with real, commonly published values (datasheets, standards). If you are not sure, say so in "unsure" instead of guessing.',
        `${designLine(design)}\nQuestions:\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`, RESEARCH_SCHEMA);
      facts = (Array.isArray(r.facts) ? r.facts : []).slice(0, 8).map(f => `${cap(f.fact, 100)}: ${cap(f.value, 80)}`);
      unsure = list(r.unsure, 4, 120);
      step('researcher', 'done', facts.length ? facts.join('; ') : 'Nothing certain found; the developer will use the request as given.');
    } else step('researcher', 'done', 'No research needed.');

    const brief = `Plan: ${list(plan.steps, 5, 160).join(' ')}\nAcceptance: ${acceptance.join(' | ')}\nResearch: ${facts.join(' | ') || 'none'}${unsure.length ? `\nUnsure (keep conservative): ${unsure.join(' | ')}` : ''}`;
    step('developer', 'working', 'Writing the code…');
    let d = await develop(brief, start.code), b = await build(d.code, 'the first version'), audit = null;
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      step('auditor', 'working', b.ok ? 'Checking the result against the plan…' : 'Reviewing the OpenSCAD error…');
      audit = await call('You are the auditor on a CAD team. Check the developer\'s OpenSCAD against the acceptance criteria and the compile result. Be strict but brief. pass=true only if it compiles and meets every criterion.',
        `${designLine(design)}\nRequest: ${ask}\nAcceptance: ${acceptance.join(' | ')}\nCompile: ${b.ok ? 'OK' : `FAILED: ${b.error}`}\nCode:\n${b.code || d.code}`, AUDIT_SCHEMA);
      const issues = list(audit.issues, 5, 160);
      if (b.ok && audit.pass) { step('auditor', 'done', 'Passed.'); break; }
      step('auditor', 'done', issues.join('; ') || (b.ok ? 'Needs changes.' : b.error));
      if (round === MAX_ROUNDS) break;
      step('developer', 'working', 'Fixing what the auditor found…');
      d = await develop(`${brief}\nThe auditor found: ${issues.join(' | ')}${b.ok ? '' : `\nOpenSCAD error: ${b.error}`}\nFix: ${cap(audit.fix, 400)}`, b.code || d.code);
      b = await build(d.code, 'the fix');
    }
    if (!b.ok) { step('manager', 'failed', `It still doesn't compile: ${b.error}`); return { ok: false, error: b.error, code: b.code, steps, calls, ms: Date.now() - t0, provider: used }; }

    step('manager', 'working', 'Signing off…');
    const so = await call('You are the manager. Summarise for the user in plain words what changed (2 sentences at most) and list honest caveats (things not verified, estimates).',
      `Request: ${ask}\nAuditor passed: ${audit?.pass ? 'yes' : 'no'} (${list(audit?.issues, 5, 160).join(' | ') || 'no issues'})\nDeveloper summary: ${d.summary}\nResearch: ${facts.join(' | ') || 'none'}; unsure: ${unsure.join(' | ') || 'none'}`, SIGNOFF_SCHEMA);
    const caveats = list(so.caveats, 4, 160);
    if (!audit?.pass) caveats.unshift('The auditor did not fully pass this version; check it before you build it.');
    step('manager', 'done', cap(so.summary, 300));
    return { ok: true, code: b.code, stl: b.stl, summary: cap(so.summary, 300), caveats, steps, calls, ms: Date.now() - t0, provider: used };
  } catch (e) {
    const error = e?.code === 'NO_KEY' ? e.message : `The model call failed: ${cap(e?.message || e, 160)}`;
    step('manager', 'failed', error);
    return { ok: false, error, steps, calls, ms: Date.now() - t0, provider: used };
  }
}
