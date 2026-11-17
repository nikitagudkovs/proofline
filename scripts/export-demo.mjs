// Save a finished run from a running `proofline ui` as a JSON file the static demo can replay.
//   node scripts/export-demo.mjs http://127.0.0.1:4717 demo/run.json
import { writeFileSync } from 'node:fs';
import os from 'node:os';

const [base = 'http://127.0.0.1:4717', out = 'demo/run.json'] = process.argv.slice(2);

const page = await (await fetch(base)).text();
const token = page.match(/"token":"([0-9a-f]+)"/)?.[1];
if (!token) throw new Error(`No proofline UI at ${base}`);
const get = async (path) => {
  const res = await fetch(base + path, { headers: { 'x-proofline-token': token } });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
};

const overview = await get('/api/overview');
if (overview.job) throw new Error('A job is still running. Export when the run has finished.');
const runId = overview.runs[0]?.id;
if (!runId) throw new Error('There is no run to export.');
const run = await get(`/api/runs/${runId}`);

const sessions = {};
for (const s of run.sessions) sessions[s.id] = await get(`/api/runs/${runId}/sessions/${s.id}`);
for (const s of overview.authoring.sessions) sessions[s.id] = await get(`/api/runs/_authoring/sessions/${s.id}`);

// The demo is public: keep what happened, drop where it happened and who was signed in.
const login = overview.accounts.map((a) => a.detail.match(/opened as (\S+)/)?.[1]).find(Boolean);
let text = JSON.stringify({ overview: { ...overview, runs: overview.runs.slice(0, 1), job: null, lastError: '' }, run, sessions });
text = text.split(overview.repo.root).join('~/code/textkit').split(os.homedir()).join('~');
if (login) text = text.split(login).join('ada');
const data = JSON.parse(text);
data.overview.repo.name = 'textkit';
for (const a of data.overview.accounts) if (a.label === 'git remote') a.detail = 'ship pushes to git@github.com:ada/textkit.git';
for (const view of Object.values(data.sessions)) delete view.meta.claudeSessionId;
for (const s of [...data.run.sessions, ...data.overview.authoring.sessions]) delete s.claudeSessionId;
for (const t of Object.values(data.run.state.tasks)) delete t.sessionId;

writeFileSync(out, JSON.stringify(data));
console.log(`${out}: run ${runId}, ${Object.keys(sessions).length} sessions, ${(JSON.stringify(data).length / 1024).toFixed(0)} KB`);
