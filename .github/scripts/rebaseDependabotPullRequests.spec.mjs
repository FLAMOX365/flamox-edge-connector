// #region Imports
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rebaseDependabotPullRequests } from './rebaseDependabotPullRequests.mjs';
// #endregion

const prefix = 'repos/FLAMOX365/flamox-edge-connector';
const mainSha = 'a'.repeat(40);
const context = {
  eventName: 'push',
  ref: 'refs/heads/main',
  repository: 'FLAMOX365/flamox-edge-connector',
  repositoryId: 1317851991,
  defaultBranch: 'main',
};

function fixture() {
  const identity = { id: 1317851991, full_name: context.repository };
  const records = {
    repository: {
      ...identity,
      name: 'flamox-edge-connector',
      default_branch: 'main',
      fork: false,
      private: false,
      visibility: 'public',
    },
    main: { name: 'main', commit: { sha: mainSha } },
    pull: {
      number: 7,
      state: 'open',
      draft: false,
      merged: false,
      user: { login: 'dependabot[bot]', type: 'Bot' },
      head: { sha: 'b'.repeat(40), ref: 'dependabot/npm/update', repo: identity },
      base: { ref: 'main', sha: mainSha, repo: identity },
    },
    behind: 1,
    runs: [],
    update: true,
  };
  const calls = [];
  const request = async (method, endpoint, body) => {
    calls.push({ method, endpoint, body });
    if (method === 'PUT' && endpoint === `${prefix}/pulls/7/update-branch`) {
      if (records.update) {
        records.pull.head.sha = 'c'.repeat(40);
        records.behind = 0;
      }
      return { message: 'Updating pull request branch' };
    }
    if (method === 'POST' && endpoint === `${prefix}/actions/workflows/ci.yml/dispatches`) {
      records.runs.push({ head_sha: records.pull.head.sha });
      return undefined;
    }
    if (endpoint === 'repositories/1317851991') return structuredClone(records.repository);
    if (endpoint === `${prefix}/branches/main`) return structuredClone(records.main);
    if (endpoint === `${prefix}/pulls?state=open&base=main&per_page=100&page=1`)
      return [structuredClone(records.pull)];
    if (endpoint === `${prefix}/pulls/7`) return structuredClone(records.pull);
    if (endpoint.startsWith(`${prefix}/compare/`))
      return { behind_by: records.behind, merge_base_commit: { sha: mainSha } };
    if (endpoint.startsWith(`${prefix}/actions/workflows/ci.yml/runs?`))
      return { workflow_runs: structuredClone(records.runs) };
    throw new Error('Unexpected fixture request.');
  };
  return { records, calls, request, sleep: async () => {} };
}

test('updates the expected bot head and dispatches CI once without bot comments', async () => {
  const dependencies = fixture();
  const result = await rebaseDependabotPullRequests(context, dependencies);
  assert.deepEqual(result.updated, [7]);
  assert.deepEqual(result.dispatched, [7]);
  assert.deepEqual(dependencies.calls.filter((call) => call.method !== 'GET'), [
    { method: 'PUT', endpoint: `${prefix}/pulls/7/update-branch`,
      body: { expected_head_sha: 'b'.repeat(40) } },
    { method: 'POST', endpoint: `${prefix}/actions/workflows/ci.yml/dispatches`,
      body: { ref: 'dependabot/npm/update' } },
  ]);
  const repeated = await rebaseDependabotPullRequests(context, dependencies);
  assert.deepEqual(repeated.updated, []);
  assert.deepEqual(repeated.dispatched, []);
});

test('recovers when the branch update succeeded before CI could be dispatched', async () => {
  const dependencies = fixture();
  dependencies.records.behind = 0;
  const result = await rebaseDependabotPullRequests(context, dependencies);
  assert.deepEqual(result.updated, []);
  assert.deepEqual(result.dispatched, [7]);
  assert.equal(dependencies.calls.some((call) => call.method === 'PUT'), false);
});

test('does not dispatch an unconfirmed asynchronous update', async () => {
  const dependencies = fixture();
  dependencies.records.update = false;
  await assert.rejects(rebaseDependabotPullRequests(context, dependencies), /not confirmed/u);
  assert.equal(dependencies.calls.some((call) => call.method === 'POST'), false);
});

test('keeps conflicts and human pull requests out of automatic branch writes', async () => {
  for (const kind of ['human', 'conflict', 'foreign-context']) {
    const dependencies = fixture();
    if (kind === 'human') dependencies.records.pull.user.login = 'human';
    if (kind === 'conflict') dependencies.records.pull.mergeable_state = 'dirty';
    const selected = kind === 'foreign-context'
      ? { ...context, ref: 'refs/heads/feature' } : context;
    await rebaseDependabotPullRequests(selected, dependencies);
    assert.equal(dependencies.calls.some((call) => call.method !== 'GET'), false);
  }
});
