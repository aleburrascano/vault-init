import { execa } from 'execa';
import { findTool } from './platform.js';

async function gh(...args) {
  const ghPath = await findTool('gh');
  if (!ghPath) throw new Error('gh CLI not found. Install from https://cli.github.com');
  return execa(ghPath, args, { reject: false });
}

async function ghJson(...args) {
  const result = await gh(...args);
  if (result.exitCode !== 0) throw new Error(`gh ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

// ── Pure JSON parsers (exported for unit tests) ───────────────────────────────

export function _parseUserJson(json) {
  const data = JSON.parse(json);
  if (!data.login) throw new Error('login field missing from user response');
  return data.login;
}

export function _parsePlanJson(json) {
  const data = JSON.parse(json);
  return data?.plan?.name ?? 'free';
}

export function _parseRepoJson(json) {
  const data = JSON.parse(json);
  return {
    visibility: data.visibility,
    isAdmin: data?.permissions?.admin === true,
  };
}

export function _parsePagesJson(json) {
  if (!json) return null;
  try {
    const data = JSON.parse(json);
    if (typeof data.public === 'boolean') return data.public ? 'public' : 'private';
    if (data.visibility) return data.visibility === 'public' ? 'public' : 'private';
    return 'public';
  } catch {
    return null;
  }
}

// ── Live gh wrappers ──────────────────────────────────────────────────────────

export async function getCurrentUser() {
  const json = await ghJson('api', 'user');
  return _parseUserJson(json);
}

export async function getUserPlan() {
  const json = await ghJson('api', 'user');
  return _parsePlanJson(json);
}

export async function isAuthenticated() {
  const result = await gh('auth', 'status');
  return result.exitCode === 0;
}

export async function createRepo(name, { visibility = 'private' } = {}) {
  await ghJson('repo', 'create', name, `--${visibility}`, '--confirm');
}

export async function deleteRepo(slug) {
  await ghJson('repo', 'delete', slug, '--yes');
}

export async function repoExists(slug) {
  const result = await gh('repo', 'view', slug);
  return result.exitCode === 0;
}

export async function isAdmin(slug) {
  try {
    const json = await ghJson('api', `repos/${slug}`);
    return _parseRepoJson(json).isAdmin;
  } catch {
    return false;
  }
}

export async function getVisibility(slug) {
  const json = await ghJson('api', `repos/${slug}`);
  return _parseRepoJson(json).visibility;
}

export async function enablePages(slug, { buildType = 'workflow' } = {}) {
  await ghJson('api', `repos/${slug}/pages`, '--method', 'POST',
    '--field', `build_type=${buildType}`,
    '--field', 'source[branch]=main',
    '--field', 'source[path]=/');
}

export async function setPagesVisibility(slug, visibility) {
  await ghJson('api', `repos/${slug}/pages`, '--method', 'PUT',
    '--field', `public=${visibility === 'public'}`);
}

export async function disablePages(slug) {
  await gh('api', `repos/${slug}/pages`, '--method', 'DELETE');
}

export async function pagesExist(slug) {
  const result = await gh('api', `repos/${slug}/pages`);
  return result.exitCode === 0;
}

export async function getPagesVisibility(slug) {
  const result = await gh('api', `repos/${slug}/pages`);
  if (result.exitCode !== 0) return null;
  return _parsePagesJson(result.stdout);
}

export async function ensureDeleteRepoScope() {
  const ghPath = await findTool('gh');
  if (!ghPath) throw new Error('gh CLI not found');
  await execa(ghPath, ['auth', 'refresh', '-h', 'github.com', '-s', 'delete_repo'], { timeout: 10_000, reject: false });
}
