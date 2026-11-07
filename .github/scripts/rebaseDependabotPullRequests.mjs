// #region Imports

import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { requestDependabotGitHub } from './requestDependabotGitHub.mjs';
import { resolveDependabotRepository } from './resolveDependabotRepository.mjs';
import { mergeDependabotPullRequest } from './mergeDependabotPullRequest.mjs';

// #endregion

const shaPattern = /^[0-9a-f]{40}$/u;
const maximumPages = 10;
const pageSize = 100;
const requestFailure =
  'Dependabot rebase stopped after a GitHub API request failed; inspect the workflow before retrying.';

/**
 * Updates same-repository Dependabot branches through GitHub's branch API,
 * then approves only the matching native PR workflow that GitHub holds for
 * GITHUB_TOKEN-authored updates. No foreign or human pull request is approved.
 * Partial completion is recoverable by inspecting the current head and its
 * existing CI runs. Human PRs, foreign repositories and changed heads are skipped.
 */
export async function rebaseDependabotPullRequests(context, dependencies = {}) {
  const boundary = dependencies.request ?? requestDependabotGitHub;
  const sleep = dependencies.sleep ?? delay;
  const request = async (method, endpoint, body) => {
    try {
      return await boundary(method, endpoint, body);
    } catch {
      throw new Error(requestFailure);
    }
  };
  const identity = await resolveDependabotRepository(context, request);
  if (!identity) return { status: 'skipped', reason: 'unsupported-repository' };
  if (
    !['push', 'workflow_dispatch'].includes(context?.eventName) ||
    context?.ref !== `refs/heads/${identity.defaultBranch}`
  )
    return { status: 'skipped', reason: 'unsupported-context' };

  const repositoryPath = identity.path;
  const mainPath = `${repositoryPath}/branches/${encodeURIComponent(identity.defaultBranch)}`;
  const main = await request('GET', mainPath);
  const mainSha = main?.commit?.sha;
  if (main?.name !== identity.defaultBranch || !shaPattern.test(mainSha ?? ''))
    return { status: 'skipped', reason: 'invalid-main' };

  const pullRequests = await pages(
    request,
    `${repositoryPath}/pulls?state=open&base=${encodeURIComponent(identity.defaultBranch)}`,
  );
  const result = { status: 'completed', mainSha, updated: [], approved: [], merged: [], pending: [], skipped: [] };
  const mergeVerified = async (pull, run) => {
    const merge = dependencies.merge ?? mergeDependabotPullRequest;
    const confirmed = await merge({
      ...context, runId: run.id, runAttempt: run.run_attempt,
    }, { request });
    if (confirmed.status !== 'merged') {
      // A concurrent native auto-merge can finish before our merge read.
      const current = await request('GET', `${repositoryPath}/pulls/${pull.number}`);
      if (current?.merged !== true || current.node_id !== pull.node_id ||
          current.head?.sha !== pull.head.sha ||
          current.head?.repo?.id !== identity.id ||
          current.base?.repo?.id !== identity.id ||
          current.base?.ref !== identity.defaultBranch ||
          !shaPattern.test(current.merge_commit_sha ?? ''))
        throw new Error('The verified Dependabot merge was not confirmed.');
    }
    result.merged.push(pull.number);
  };
  const seen = new Set();
  const skip = (number, reason) => result.skipped.push({ number, reason });

  for (const listed of pullRequests) {
    const number = listed?.number;
    if (!Number.isSafeInteger(number) || number < 1 || seen.has(number)) continue;
    seen.add(number);
    if (!eligiblePullRequest(listed, number, identity)) {
      skip(number, 'ineligible-pull-request');
      continue;
    }

    const pullRequestPath = `${repositoryPath}/pulls/${number}`;
    let pullRequest = await request('GET', pullRequestPath);
    if (!samePullRequest(pullRequest, listed, identity)) {
      skip(number, 'pull-request-changed');
      continue;
    }
    const comparison = await request(
      'GET', `${repositoryPath}/compare/${mainSha}...${pullRequest.head.sha}`,
    );
    if (!Number.isSafeInteger(comparison?.behind_by) || comparison.behind_by < 0) {
      skip(number, 'unknown-comparison');
      continue;
    }
    if (pullRequest.mergeable_state === 'dirty') {
      skip(number, 'merge-conflict');
      continue;
    }

    const currentMain = await request('GET', mainPath);
    if (currentMain?.name !== identity.defaultBranch || currentMain?.commit?.sha !== mainSha)
      return { ...result, status: 'stopped', reason: 'main-changed' };

    if (comparison.behind_by > 0) {
      const original = pullRequest;
      const current = await request('GET', pullRequestPath);
      if (!samePullRequest(current, original, identity)) {
        skip(number, 'pull-request-changed');
        continue;
      }
      await request('PUT', `${pullRequestPath}/update-branch`, {
        expected_head_sha: original.head.sha,
      });
      // GitHub accepts the update asynchronously. Never dispatch the old head.
      for (let attempt = 0; attempt < 10; attempt++) {
        pullRequest = await request('GET', pullRequestPath);
        if (!eligiblePullRequest(pullRequest, number, identity))
          throw new Error('Dependabot pull request changed during its branch update.');
        if (pullRequest.head.sha !== original.head.sha) break;
        await sleep(1000);
      }
      const updated = await request(
        'GET', `${repositoryPath}/compare/${mainSha}...${pullRequest.head.sha}`,
      );
      if (pullRequest.head.sha === original.head.sha ||
          updated?.behind_by !== 0 || updated?.merge_base_commit?.sha !== mainSha)
        throw new Error('GitHub has not confirmed an up-to-date Dependabot branch.');
      result.updated.push(number);
    }

    // GitHub creates an approval-required PR run after GITHUB_TOKEN updates.
    // Approving that run preserves its PR association and the required checks.
    let run;
    for (let attempt = 0; attempt < 30; attempt++) {
      const runs = await request('GET',
        `${repositoryPath}/actions/workflows/ci.yml/runs?branch=${encodeURIComponent(pullRequest.head.ref)}&head_sha=${pullRequest.head.sha}&event=pull_request&per_page=100`,
      );
      if (!Array.isArray(runs?.workflow_runs)) throw new Error('Invalid CI run metadata.');
      run = runs.workflow_runs.find((candidate) =>
        eligibleRun(candidate, pullRequest, identity));
      if (run) break;
      await sleep(1000);
    }
    if (!run) throw new Error('GitHub has not created the native Dependabot PR verification.');
    if (run.status === 'completed' &&
        !['action_required', 'success'].includes(run.conclusion)) {
      skip(number, 'verification-failed');
      continue;
    }
    const latest = await request('GET', pullRequestPath);
    const latestMain = await request('GET', mainPath);
    if (!samePullRequest(latest, pullRequest, identity)) {
      skip(number, 'pull-request-changed');
      continue;
    }
    if (latestMain?.commit?.sha !== mainSha)
      return { ...result, status: 'stopped', reason: 'main-changed' };
    const latestRun = await request('GET', `${repositoryPath}/actions/runs/${run.id}`);
    if (!eligibleRun(latestRun, latest, identity)) {
      skip(number, 'verification-changed');
      continue;
    }
    if (latestRun.conclusion === 'action_required') {
      await request('POST', `${repositoryPath}/actions/runs/${run.id}/approve`);
      result.approved.push(number);
    }
    if (latestRun.status === 'completed' &&
        !['action_required', 'success'].includes(latestRun.conclusion)) {
      skip(number, 'verification-failed');
      continue;
    }
    if (latest.auto_merge == null) {
      // GitHub's native auto-merge enforces the repository's required checks.
      // A completed, clean PR is merged through the same exact-run validator.
      if (latestRun.conclusion === 'success') {
        await mergeVerified(latest, latestRun);
        return { ...result, status: 'stopped', reason: 'main-changed' };
      }
      const enabled = await request('POST', 'graphql', {
        query: `mutation EnableDependencyAutoMerge($id: ID!) {
          enablePullRequestAutoMerge(input: {pullRequestId: $id, mergeMethod: SQUASH}) {
            pullRequest {
              number headRefOid baseRefName state
              mergeCommit { oid }
              autoMergeRequest { enabledAt }
            }
          }
        }`,
        variables: { id: latest.node_id },
      });
      const confirmed = enabled?.data?.enablePullRequestAutoMerge?.pullRequest;
      if (!enabled?.errors?.length && confirmed?.number === number &&
          confirmed.headRefOid === latest.head.sha &&
          confirmed.baseRefName === identity.defaultBranch &&
          confirmed.state === 'MERGED' && shaPattern.test(confirmed.mergeCommit?.oid ?? '')) {
        result.merged.push(number);
        return { ...result, status: 'stopped', reason: 'main-changed' };
      }
      if (enabled?.errors?.length || confirmed?.number !== number ||
          confirmed.headRefOid !== latest.head.sha ||
          confirmed.baseRefName !== identity.defaultBranch ||
          confirmed.state !== 'OPEN' || !confirmed.autoMergeRequest) {
        // Verification may have completed between the read and the mutation.
        await mergeVerified(latest, latestRun);
        return { ...result, status: 'stopped', reason: 'main-changed' };
      }
    }
    result.pending.push({ number, runId: latestRun.id });
  }
  return result;
}

/**
 * Keeps a trusted metadata owner alive until native auto-merge advances main.
 * Actions-authored merges do not emit a new push workflow, so the owner starts
 * the next bounded queue iteration explicitly. CI failures preserve the PRs.
 */
export async function advanceDependabotQueue(context, result, dependencies = {}) {
  if (!['push', 'workflow_dispatch'].includes(context?.eventName) ||
      context.ref !== 'refs/heads/main' ||
      !['completed', 'stopped'].includes(result?.status))
    return { status: 'idle' };
  if (!result.pending?.length && result.reason !== 'main-changed')
    return { status: 'idle' };
  const request = dependencies.request ?? requestDependabotGitHub;
  const sleep = dependencies.sleep ?? delay;
  const identity = await resolveDependabotRepository(context, request);
  if (!identity) return { status: 'idle' };
  const mainPath = `${identity.path}/branches/${encodeURIComponent(identity.defaultBranch)}`;
  for (let attempt = 0; attempt < 110; attempt++) {
    const main = await request('GET', mainPath);
    if (main?.name !== identity.defaultBranch || !shaPattern.test(main?.commit?.sha ?? ''))
      throw new Error('Invalid default branch while waiting for Dependabot.');
    if (main.commit.sha !== result.mainSha) {
      await request('POST', `${identity.path}/actions/workflows/rebase-dependabot.yml/dispatches`, {
        ref: identity.defaultBranch,
      });
      return { status: 'advanced', mainSha: main.commit.sha };
    }
    let allFailed = result.pending.length > 0;
    for (const { runId } of result.pending) {
      const run = await request('GET', `${identity.path}/actions/runs/${runId}`);
      if (run?.id !== runId || typeof run.status !== 'string')
        throw new Error('Invalid Dependabot verification while waiting for merge.');
      if (run.status !== 'completed' ||
          !['failure', 'cancelled', 'timed_out', 'skipped', 'startup_failure'].includes(run.conclusion)) {
        allFailed = false;
        break;
      }
    }
    if (allFailed) return { status: 'verification-failed' };
    await sleep(30_000);
  }
  return { status: 'timed-out' };
}

function eligibleRun(run, pullRequest, identity) {
  return (
    Number.isSafeInteger(run?.id) && run.id > 0 &&
    Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0 &&
    run.event === 'pull_request' &&
    run.name === 'CI' &&
    typeof run.path === 'string' &&
    (run.path === '.github/workflows/ci.yml' ||
     run.path.startsWith('.github/workflows/ci.yml@')) &&
    run.repository?.id === identity.id &&
    run.repository?.full_name === identity.fullName &&
    run.head_repository?.id === identity.id &&
    run.head_repository?.full_name === identity.fullName &&
    run.head_sha === pullRequest.head.sha &&
    run.head_branch === pullRequest.head.ref &&
    Array.isArray(run.pull_requests) && run.pull_requests.length === 1 &&
    run.pull_requests[0]?.number === pullRequest.number
  );
}

function eligiblePullRequest(value, number, identity) {
  return (
    value?.number === number &&
    typeof value.node_id === 'string' && value.node_id.length > 0 &&
    value?.state === 'open' &&
    value?.draft === false &&
    value?.merged !== true &&
    value?.user?.login === 'dependabot[bot]' &&
    value?.user?.type === 'Bot' &&
    value?.head?.repo?.id === identity.id &&
    value?.head?.repo?.full_name === identity.fullName &&
    value?.base?.repo?.id === identity.id &&
    value?.base?.repo?.full_name === identity.fullName &&
    value?.base?.ref === identity.defaultBranch &&
    typeof value?.head?.ref === 'string' && value.head.ref.length > 0 &&
    shaPattern.test(value?.head?.sha ?? '') &&
    shaPattern.test(value?.base?.sha ?? '')
  );
}

function samePullRequest(value, previous, identity) {
  return (
    eligiblePullRequest(value, previous.number, identity) &&
    value.head.sha === previous.head.sha &&
    value.head.ref === previous.head.ref &&
    value.base.sha === previous.base.sha
  );
}

async function pages(request, endpoint) {
  const results = [];
  const separator = endpoint.includes('?') ? '&' : '?';

  for (let page = 1; page <= maximumPages; page++) {
    const rows = await request('GET', `${endpoint}${separator}per_page=${pageSize}&page=${page}`);

    if (!Array.isArray(rows) || rows.length > pageSize)
      throw new Error('GitHub returned invalid Dependabot pagination data.');

    results.push(...rows);

    if (rows.length < pageSize) return results;
  }

  throw new Error('Dependabot metadata exceeded its pagination budget; no further work started.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2)
      throw new Error('Dependabot rebase accepts only its main-branch workflow environment.');

    const context = {
      repository: process.env.GITHUB_REPOSITORY,
      repositoryId: process.env.GITHUB_REPOSITORY_ID,
      defaultBranch: process.env.DEFAULT_BRANCH,
      eventName: process.env.GITHUB_EVENT_NAME,
      ref: process.env.GITHUB_REF,
    };
    const result = await rebaseDependabotPullRequests(context);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    const queue = await advanceDependabotQueue(context, result);
    process.stdout.write(`${JSON.stringify(queue)}\n`);
    if (['verification-failed', 'timed-out'].includes(queue.status))
      process.exitCode = 1;
  } catch {
    process.stderr.write('Dependabot rebase could not complete; inspect the workflow run.\n');
    process.exitCode = 1;
  }
}
