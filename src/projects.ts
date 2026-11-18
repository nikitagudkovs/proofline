import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DIR, hashContract, parseContract } from './contract.js';
import { listRuns, loadState, newRunId } from './state.js';
import type { Contract, Plan, Project, RunState } from './types.js';
import { parsePlan } from './plan.js';

/**
 * Projects: every goal you work on is kept, with its contract, its plan and its runs.
 *
 * One project is open at a time. Its files are where they have always been, at the top of
 * .proofline (contract.yaml, approval.json, plan.yaml), so they can still be edited by hand.
 * The others rest in .proofline/projects/<id>/ until they are opened again; opening one
 * puts the open project's files away and brings the other's back. Runs are never moved:
 * each run records the project it belongs to.
 */
export const projectsDir = (root: string) => path.join(root, DIR, 'projects');
export const projectDir = (root: string, id: string) => path.join(projectsDir(root), id);
const metaPath = (root: string, id: string) => path.join(projectDir(root, id), 'project.json');
const openPath = (root: string) => path.join(projectsDir(root), 'open');

/** What belongs to the open project: where it sits while open, and its name while put away. */
const FILES: [open: string, away: string][] = [
  ['contract.yaml', 'contract.yaml'],
  ['approval.json', 'approval.json'],
  ['plan.yaml', 'plan.yaml'],
  [path.join('runs', 'planner-usage.json'), 'planner-usage.json'],
  [path.join('runs', '_authoring'), 'authoring'],
];

const titleFrom = (text: string): string => {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
};

function readMeta(root: string, id: string): Project | undefined {
  try {
    return JSON.parse(readFileSync(metaPath(root, id), 'utf8'));
  } catch {
    return undefined;
  }
}

function writeMeta(root: string, project: Project): void {
  mkdirSync(projectDir(root, project.id), { recursive: true });
  writeFileSync(metaPath(root, project.id), `${JSON.stringify(project, null, 2)}\n`);
}

export function loadProject(root: string, id: string): Project {
  const project = readMeta(root, id);
  if (!project) throw new Error(`No project ${id} here. List them with: proofline projects`);
  return project;
}

/** Newest first. */
export function listProjects(root: string): Project[] {
  if (!existsSync(projectsDir(root))) return [];
  return readdirSync(projectsDir(root))
    .map((id) => readMeta(root, id))
    .filter((p): p is Project => !!p)
    .sort((a, b) => b.id.localeCompare(a.id));
}

/** The id of the open project, if there is one. */
export function openProjectId(root: string): string | undefined {
  try {
    const id = readFileSync(openPath(root), 'utf8').trim();
    return id && readMeta(root, id) ? id : undefined;
  } catch {
    return undefined;
  }
}

function freshId(root: string): string {
  let id = newRunId();
  for (let n = 2; existsSync(projectDir(root, id)); n++) id = `${newRunId()}-${n}`;
  return id;
}

function create(root: string, goal: string, title = titleFrom(goal)): Project {
  const now = new Date().toISOString();
  const project: Project = { id: freshId(root), title: title || 'Untitled', goal, createdAt: now, updatedAt: now };
  writeMeta(root, project);
  return project;
}

function move(from: string, to: string): void {
  if (!existsSync(from)) return;
  rmSync(to, { recursive: true, force: true });
  mkdirSync(path.dirname(to), { recursive: true });
  renameSync(from, to);
}

const putAway = (root: string, id: string) => FILES.forEach(([open, away]) => move(path.join(root, DIR, open), path.join(projectDir(root, id), away)));
const bringBack = (root: string, id: string) => FILES.forEach(([open, away]) => move(path.join(projectDir(root, id), away), path.join(root, DIR, open)));
const setOpen = (root: string, id: string) => {
  mkdirSync(projectsDir(root), { recursive: true });
  writeFileSync(openPath(root), `${id}\n`);
};

/**
 * The open project. A folder that was used before projects existed has a contract and no
 * project: that work becomes the first project, as it stands, with the runs made for it.
 */
export function ensureProject(root: string): Project {
  const id = openProjectId(root);
  if (id) {
    // Interrupted half-way through opening it: its files are still put away. Finish the job.
    if (!existsSync(path.join(root, DIR, 'contract.yaml')) && existsSync(path.join(projectDir(root, id), 'contract.yaml'))) bringBack(root, id);
    return loadProject(root, id);
  }
  let contract: Contract | undefined;
  try {
    contract = parseContract(readFileSync(path.join(root, DIR, 'contract.yaml'), 'utf8'));
  } catch {
    // no contract yet, or one that does not parse: the project starts without a name
  }
  const project = create(root, '', contract ? titleFrom(contract.goal) : '');
  if (contract) {
    const hash = hashContract(contract);
    const runs = listRuns(root).filter((run) => loadState(root, run).contractHash === hash);
    if (runs.length) writeMeta(root, Object.assign(project, { adopted: runs }));
  }
  setOpen(root, project.id);
  return project;
}

/** The open project has nothing in it yet: no goal, no contract, no run, no name of its own. */
function isBlank(root: string, project: Project): boolean {
  return !project.goal && !project.named && !existsSync(path.join(root, DIR, 'contract.yaml')) && projectRuns(root, project).length === 0;
}

/** Leave the open project: put its files away, or, if it never held anything, drop it so empty ones do not pile up. */
function leave(root: string, project: Project): void {
  const blank = isBlank(root, project);
  putAway(root, project.id);
  if (blank) rmSync(projectDir(root, project.id), { recursive: true, force: true });
}

/** Put the open project away and start an empty one. Nothing of the old one is lost. */
export function newProject(root: string, goal = ''): Project {
  const current = ensureProject(root);
  // An empty project is already the fresh start that was asked for.
  if (isBlank(root, current)) return updateProject(root, current.id, { goal });
  putAway(root, current.id);
  const project = create(root, goal.trim());
  setOpen(root, project.id);
  return project;
}

/** Make another project the open one: its contract, approval and plan are back where the commands expect them. */
export function openProject(root: string, id: string): Project {
  const target = loadProject(root, id);
  const current = ensureProject(root);
  if (current.id === id) return target;
  leave(root, current);
  bringBack(root, id);
  setOpen(root, id);
  return target;
}

/** Change the open project's name or goal text. A name a person chose is never replaced by a derived one. */
export function updateProject(root: string, id: string, patch: { title?: string; goal?: string }): Project {
  const project = loadProject(root, id);
  if (patch.goal !== undefined) {
    project.goal = patch.goal.trim();
    if (!project.named && titleFrom(project.goal)) project.title = titleFrom(project.goal);
  }
  if (patch.title !== undefined && patch.title.trim()) {
    project.title = patch.title.trim().slice(0, 120);
    project.named = true;
  }
  project.updatedAt = new Date().toISOString();
  writeMeta(root, project);
  return project;
}

/** Mark the open project as worked on now. */
export function touchProject(root: string): void {
  const project = ensureProject(root);
  project.updatedAt = new Date().toISOString();
  writeMeta(root, project);
}

/**
 * The project a new goal belongs to. A project that already has a run is finished work, or
 * work under way: a new goal never overwrites it, it starts a project of its own.
 */
export function projectForGoal(root: string, goal: string): Project {
  const current = ensureProject(root);
  if (projectRuns(root, current).length > 0) return newProject(root, goal);
  return updateProject(root, current.id, { goal });
}

/** Whether a run was made for this project. */
export const belongs = (project: Project, state: RunState) => state.project === project.id || (!state.project && !!project.adopted?.includes(state.id));

/** The runs of a project, oldest first. */
export function projectRuns(root: string, project: Project): string[] {
  return listRuns(root).filter((id) => belongs(project, loadState(root, id)));
}

/** Runs from before projects existed that no project claims. */
export function unfiledRuns(root: string): string[] {
  const projects = listProjects(root);
  return listRuns(root).filter((id) => {
    const state = loadState(root, id);
    return !state.project && !projects.some((p) => belongs(p, state));
  });
}

/** The latest run of the open project, which is the one the commands act on unless told otherwise. */
export function latestRun(root: string): RunState {
  const id = openProjectId(root);
  const ids = id ? projectRuns(root, loadProject(root, id)) : listRuns(root);
  if (ids.length === 0) throw new Error(id ? 'This project has no runs yet. Start one with: proofline run' : 'No runs yet. Start one with: proofline run');
  return loadState(root, ids[ids.length - 1]);
}

/** A project's contract and plan, wherever they are right now. Missing or unreadable files are simply absent. */
export function projectFiles(root: string, id: string): { contract?: Contract; hash?: string; approved: boolean; plan?: Plan } {
  const isOpen = openProjectId(root) === id;
  const file = (open: string, away: string) => (isOpen ? path.join(root, DIR, open) : path.join(projectDir(root, id), away));
  const out: { contract?: Contract; hash?: string; approved: boolean; plan?: Plan } = { approved: false };
  try {
    out.contract = parseContract(readFileSync(file('contract.yaml', 'contract.yaml'), 'utf8'));
    out.hash = hashContract(out.contract);
    out.approved = JSON.parse(readFileSync(file('approval.json', 'approval.json'), 'utf8')).hash === out.hash;
  } catch {
    // no contract, no approval, or a file that does not parse
  }
  try {
    out.plan = parsePlan(readFileSync(file('plan.yaml', 'plan.yaml'), 'utf8'));
  } catch {
    // no plan
  }
  return out;
}
