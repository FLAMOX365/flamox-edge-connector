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
    run: {
      id: 202, event: 'pull_request', name: 'CI',
      path: '.github/workflows/ci.yml',
      repository: identity, head_repository: identity,
      head_sha: 'b'.repeat(40), head_branch: 'dependabot/npm/update',
      pull_requests: [{ number: 7 }],
      conclusion: 'action_required', status: 'completed',
    },
    update: true,
  };
  const calls = [];
  const request = async (method, endpoint, body) => {
    calls.push({ method, endpoint, body });
    if (method === 'PUT' && endpoint === `${prefix}/pulls/7/update-branch`) {
      if (records.update) {
        records.pull.head.sha = 'c'.repeat(40);
        records.run.head_sha = records.pull.head.sha;
        records.behind = 0;
      }
      return { message: 'Updating pull request branch' };
    }
    if (method === 'POST' && endpoint === `${prefix}/actions/runs/202/approve`) {
      records.run.conclusion = null;
      records.run.status = 'queued';
      return {};
    }
    if (endpoint === `${prefix}/actions/runs/202`)
      return structuredClone(records.run);
    if (endpoint === 'repositories/1317851991') return structuredClone(records.repository);
    if (endpoint === `${prefix}/branches/main`) return structuredClone(records.main);
    if (endpoint === `${prefix}/pulls?state=open&base=main&per_page=100&page=1`)
      return [structuredClone(records.pull)];
    if (endpoint === `${prefix}/pulls/7`) return structuredClone(records.pull);
    if (endpoint.startsWith(`${prefix}/compare/`))
      return { behind_by: records.behind, merge_base_commit: { sha: mainSha } };
    if (endpoint.startsWith(`${prefix}/actions/workflows/ci.yml/runs?`))
      return { workflow_runs: [structuredClone(records.run)] };
    throw new Error('Unexpected fixture request.');
  };
  return { records, calls, request, sleep: async () => {} };
}

test('updates the expected bot head and approves its native PR verification once', async () => {
  const dependencies = fixture();
  const result = await rebaseDependabotPullRequests(context, dependencies);
  assert.deepEqual(result.updated, [7]);
  assert.deepEqual(result.approved, [7]);
  assert.deepEqual(dependencies.calls.filter((call) => call.method !== 'GET'), [
    { method: 'PUT', endpoint: `${prefix}/pulls/7/update-branch`,
      body: { expected_head_sha: 'b'.repeat(40) } },
    { method: 'POST', endpoint: `${prefix}/actions/runs/202/approve`,
      body: undefined },
  ]);
  const repeated = await rebaseDependabotPullRequests(context, dependencies);
  assert.deepEqual(repeated.updated, []);
  assert.deepEqual(repeated.approved, []);
});

test('recovers when the branch update succeeded before its native CI could be approved', async () => {
  const dependencies = fixture();
  dependencies.records.behind = 0;
  const result = await rebaseDependabotPullRequests(context, dependencies);
  assert.deepEqual(result.updated, []);
  assert.deepEqual(result.approved, [7]);
  assert.equal(dependencies.calls.some((call) => call.method === 'PUT'), false);
});

test('does not approve CI for an unconfirmed asynchronous update', async () => {
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


test('does not approve an unrelated, foreign or non-PR workflow run', async () => {
  for (const kind of ['foreign', 'wrong-pr', 'wrong-head', 'wrong-workflow', 'dispatched']) {
    const dependencies = fixture();
    dependencies.records.behind = 0;
    if (kind === 'foreign') dependencies.records.run.head_repository = { id: 1 };
    if (kind === 'wrong-pr') dependencies.records.run.pull_requests = [{ number: 8 }];
    if (kind === 'wrong-head') dependencies.records.run.head_sha = 'd'.repeat(40);
    if (kind === 'wrong-workflow') dependencies.records.run.path = '.github/workflows/noop.yml';
    if (kind === 'dispatched') dependencies.records.run.event = 'workflow_dispatch';
    await assert.rejects(rebaseDependabotPullRequests(context, dependencies), /native Dependabot/u);
    assert.equal(dependencies.calls.some((call) => call.method !== 'GET'), false);
  }
});

test('does not approve a run that is already active or completed', async () => {
  for (const conclusion of [null, 'success', 'failure', 'cancelled']) {
    const dependencies = fixture();
    dependencies.records.behind = 0;
    dependencies.records.run.conclusion = conclusion;
    await rebaseDependabotPullRequests(context, dependencies);
    assert.equal(dependencies.calls.some((call) => call.method !== 'GET'), false);
  }
});
