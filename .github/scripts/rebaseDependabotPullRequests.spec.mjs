// #region Imports
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rebaseDependabotPullRequests, advanceDependabotQueue } from './rebaseDependabotPullRequests.mjs';
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
      node_id: 'PR_fixture',
      auto_merge: null,
      state: 'open',
      draft: false,
      merged: false,
      user: { login: 'dependabot[bot]', type: 'Bot' },
      head: { sha: 'b'.repeat(40), ref: 'dependabot/npm/update', repo: identity },
      base: { ref: 'main', sha: mainSha, repo: identity },
    },
    behind: 1,
    run: {
      id: 202, run_attempt: 1, event: 'pull_request', name: 'CI',
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
    if (method === 'POST' && endpoint === 'graphql') {
      records.pull.auto_merge = {};
      return { data: { enablePullRequestAutoMerge: { pullRequest: {
        number: 7, headRefOid: records.pull.head.sha, baseRefName: 'main',
        state: 'OPEN', autoMergeRequest: { enabledAt: '2026-11-07T00:00:00Z' },
      } } } };
    }
    if (method === 'POST' && endpoint === `${prefix}/actions/workflows/rebase-dependabot.yml/dispatches`)
      return undefined;
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
  const writes = dependencies.calls.filter((call) => call.method !== 'GET');
  assert.deepEqual(writes.slice(0, 2), [
    { method: 'PUT', endpoint: `${prefix}/pulls/7/update-branch`,
      body: { expected_head_sha: 'b'.repeat(40) } },
    { method: 'POST', endpoint: `${prefix}/actions/runs/202/approve`,
      body: undefined },
  ]);
  assert.equal(writes[2].endpoint, 'graphql');
  assert.deepEqual(writes[2].body.variables, { id: 'PR_fixture' });
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
    dependencies.records.pull.auto_merge = {};
    await rebaseDependabotPullRequests(context, dependencies);
    assert.equal(dependencies.calls.some((call) => call.method !== 'GET'), false);
  }
});


test('reuses exact-run validation when CI completed before auto-merge was enabled', async () => {
  const dependencies = fixture();
  dependencies.records.behind = 0;
  dependencies.records.run.conclusion = 'success';
  dependencies.merge = async (verification) => {
    assert.equal(verification.eventName, 'push');
    assert.equal(verification.ref, 'refs/heads/main');
    assert.equal(verification.runId, 202);
    assert.equal(verification.runAttempt, 1);
    return { status: 'merged', sha: 'd'.repeat(40) };
  };
  const result = await rebaseDependabotPullRequests(context, dependencies);
  assert.deepEqual(result.merged, [7]);
  assert.equal(result.reason, 'main-changed');
});

test('recognizes an identical merge completed by a concurrent native request', async () => {
  const dependencies = fixture();
  dependencies.records.behind = 0;
  dependencies.records.run.conclusion = 'success';
  dependencies.merge = async () => {
    Object.assign(dependencies.records.pull, {
      merged: true, state: 'closed', merge_commit_sha: 'd'.repeat(40),
    });
    return { status: 'skipped' };
  };
  const result = await rebaseDependabotPullRequests(context, dependencies);
  assert.deepEqual(result.merged, [7]);
});

test('starts the next queue iteration only after the actual main branch advances', async () => {
  const dependencies = fixture();
  dependencies.records.main.commit.sha = 'd'.repeat(40);
  const result = await advanceDependabotQueue(context, {
    status: 'completed', mainSha, pending: [{ number: 7, runId: 202 }],
  }, dependencies);
  assert.equal(result.status, 'advanced');
  assert.deepEqual(dependencies.calls.filter((call) => call.method !== 'GET'), [{
    method: 'POST', endpoint: `${prefix}/actions/workflows/rebase-dependabot.yml/dispatches`,
    body: { ref: 'main' },
  }]);
});

test('preserves failed verification and never dispatches a success continuation', async () => {
  const dependencies = fixture();
  dependencies.records.run.conclusion = 'failure';
  const result = await advanceDependabotQueue(context, {
    status: 'completed', mainSha, pending: [{ number: 7, runId: 202 }],
  }, dependencies);
  assert.equal(result.status, 'verification-failed');
  assert.equal(dependencies.calls.some((call) => call.method !== 'GET'), false);
});

test('bounds waiting for a pending native merge without changing status checks', async () => {
  const dependencies = fixture();
  dependencies.records.run.status = 'in_progress';
  dependencies.records.run.conclusion = null;
  let sleeps = 0;
  dependencies.sleep = async () => { sleeps++; };
  const result = await advanceDependabotQueue(context, {
    status: 'completed', mainSha, pending: [{ number: 7, runId: 202 }],
  }, dependencies);
  assert.equal(result.status, 'timed-out');
  assert.equal(sleeps, 110);
  assert.equal(dependencies.calls.some((call) => call.method !== 'GET'), false);
});

test('recovers when verification completes during native auto-merge enablement', async () => {
  const dependencies = fixture();
  dependencies.records.behind = 0;
  const request = dependencies.request;
  dependencies.request = async (method, endpoint, body) => {
    if (endpoint === 'graphql') {
      dependencies.records.run.conclusion = 'success';
      return { errors: [{ message: 'Pull request is clean' }] };
    }
    return request(method, endpoint, body);
  };
  dependencies.merge = async () => ({ status: 'merged', sha: 'd'.repeat(40) });
  const result = await rebaseDependabotPullRequests(context, dependencies);
  assert.deepEqual(result.merged, [7]);
  assert.equal(result.reason, 'main-changed');
});
