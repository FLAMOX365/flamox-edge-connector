// #region Imports
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeDependabotPullRequest } from './mergeDependabotPullRequest.mjs';
// #endregion

const prefix = 'repos/FLAMOX365/flamox-edge-connector';
const source = 'a'.repeat(40);
const head = 'b'.repeat(40);
const merged = 'c'.repeat(40);
const context = {
  eventName: 'workflow_run',
  repository: 'FLAMOX365/flamox-edge-connector',
  repositoryId: 1317851991,
  defaultBranch: 'main',
  runId: 202,
  runAttempt: 2,
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
    workflow: { id: 101, name: 'CI', path: '.github/workflows/ci.yml' },
    run: {
      id: 202,
      run_attempt: 2,
      event: 'pull_request',
      status: 'completed',
      conclusion: 'success',
      workflow_id: 101,
      name: 'CI',
      path: '.github/workflows/ci.yml',
      repository: identity,
      head_repository: identity,
      head_sha: head,
      pull_requests: [{ number: 7 }],
    },
    pull: {
      number: 7,
      state: 'open',
      draft: false,
      merged: false,
      user: { login: 'dependabot[bot]', type: 'Bot' },
      head: { sha: head, repo: identity },
      base: { ref: 'main', sha: source, repo: identity },
    },
    jobs: [
      'Verify on ubuntu-24.04',
      'Verify on macos-15',
      'Verify on windows-2025',
      'Verify',
    ].map((name, index) => ({
      id: index + 1,
      run_id: 202,
      run_attempt: 2,
      name,
      status: 'completed',
      conclusion: 'success',
    })),
    main: { name: 'main', commit: { sha: source } },
    comparison: { behind_by: 0, merge_base_commit: { sha: source } },
  };
  const calls = [];
  let mainReads = 0;
  const request = async (method, endpoint, body) => {
    calls.push({ method, endpoint, body });
    if (method === 'PUT' && endpoint === `${prefix}/pulls/7/merge`)
      return { merged: true, sha: merged };
    if (method !== 'GET') throw new Error('Unexpected fixture write.');
    if (endpoint === 'repositories/1317851991') return structuredClone(records.repository);
    if (endpoint === `${prefix}/actions/workflows/ci.yml`) return structuredClone(records.workflow);
    if (endpoint === `${prefix}/actions/runs/202`) return structuredClone(records.run);
    if (endpoint === `${prefix}/pulls/7`) return structuredClone(records.pull);
    if (endpoint === `${prefix}/commits/${head}/pulls?per_page=100`)
      return structuredClone(records.associated ?? [records.pull]);
    if (endpoint.includes('/attempts/2/jobs?'))
      return { total_count: records.jobs.length, jobs: structuredClone(records.jobs) };
    if (endpoint === `${prefix}/branches/main`) {
      mainReads++;
      return structuredClone(mainReads > 1 ? (records.nextMain ?? records.main) : records.main);
    }
    if (endpoint === `${prefix}/compare/${source}...${head}`)
      return structuredClone(records.comparison);
    throw new Error('Unexpected fixture read.');
  };
  return { records, calls, request };
}

test('merges only the verified current Dependabot head and retains its exact merge source', async () => {
  const dependencies = fixture();
  const result = await mergeDependabotPullRequest(context, dependencies);
  assert.deepEqual(result, {
    status: 'merged',
    pullRequestNumber: 7,
    sha: merged,
    defaultBranch: 'main',
  });
  assert.deepEqual(
    dependencies.calls.filter((call) => call.method !== 'GET'),
    [
      {
        method: 'PUT',
        endpoint: `${prefix}/pulls/7/merge`,
        body: { sha: head, merge_method: 'squash' },
      },
    ],
  );
});

for (const result of ['failure', 'skipped', 'cancelled', 'neutral']) {
  test(`keeps a dependency PR open when its Verify check is ${result}`, async () => {
    const dependencies = fixture();
    dependencies.records.jobs[3].conclusion = result;
    assert.equal(
      (await mergeDependabotPullRequest(context, dependencies)).reason,
      'incomplete-verification',
    );
    assert.equal(
      dependencies.calls.some((call) => call.method !== 'GET'),
      false,
    );
  });
}

test('requires all platform jobs, the exact bot identity and current main', async () => {
  for (const kind of [
    'missing-platform',
    'human',
    'foreign-repository',
    'moved-main',
    'stale-head',
  ]) {
    const dependencies = fixture();
    if (kind === 'missing-platform') dependencies.records.jobs.splice(0, 1);
    if (kind === 'human') dependencies.records.pull.user.login = 'human';
    if (kind === 'foreign-repository') dependencies.records.repository.id = 1;
    if (kind === 'moved-main')
      dependencies.records.nextMain = { name: 'main', commit: { sha: 'd'.repeat(40) } };
    if (kind === 'stale-head') dependencies.records.pull.head.sha = 'd'.repeat(40);
    assert.equal((await mergeDependabotPullRequest(context, dependencies)).status, 'skipped');
    assert.equal(
      dependencies.calls.some((call) => call.method !== 'GET'),
      false,
    );
  }
});


test('merges a dispatched CI only for its unique current Dependabot branch', async () => {
  const dependencies = fixture();
  dependencies.records.run.event = 'workflow_dispatch';
  dependencies.records.run.pull_requests = [];
  dependencies.records.run.head_branch = 'dependabot/npm/update';
  dependencies.records.pull.head.ref = 'dependabot/npm/update';
  assert.equal((await mergeDependabotPullRequest(context, dependencies)).status, 'merged');
});

test('rejects ambiguous commit associations and a mismatched dispatched branch', async () => {
  for (const kind of ['ambiguous', 'wrong-branch', 'missing-association']) {
    const dependencies = fixture();
    dependencies.records.run.event = 'workflow_dispatch';
    dependencies.records.run.pull_requests = [];
    dependencies.records.run.head_branch = 'dependabot/npm/update';
    dependencies.records.pull.head.ref = 'dependabot/npm/update';
    if (kind === 'ambiguous') dependencies.records.associated =
      [dependencies.records.pull, { ...dependencies.records.pull, number: 8 }];
    if (kind === 'wrong-branch') dependencies.records.run.head_branch = 'human';
    if (kind === 'missing-association') dependencies.records.associated = [];
    assert.equal((await mergeDependabotPullRequest(context, dependencies)).status, 'skipped');
    assert.equal(dependencies.calls.some((call) => call.method !== 'GET'), false);
  }
});
