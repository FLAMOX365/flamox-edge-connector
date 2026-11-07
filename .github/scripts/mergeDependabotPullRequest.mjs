// #region Imports

import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { requestDependabotGitHub } from './requestDependabotGitHub.mjs';
import { resolveDependabotRepository } from './resolveDependabotRepository.mjs';

// #endregion

const workflowPath = '.github/workflows/ci.yml';
const workflowName = 'CI';
const requiredJobs = [
  'Verify on ubuntu-24.04',
  'Verify on macos-15',
  'Verify on windows-2025',
  'Verify',
];
const shaPattern = /^[0-9a-f]{40}$/u;
const requestFailure =
  'Dependabot merge stopped after a GitHub API request failed; inspect the pull request before retrying.';

/**
 * Squash-merges one same-repository Dependabot pull request after its current Verify attempt succeeds.
 *
 * @param context - The workflow_run event name, immutable repository identity, default branch, triggering run ID and attempt.
 * @param dependencies - An optional request(method, endpoint, body) GitHub REST boundary for offline tests.
 * @returns A merged result or a skipped result with a fixed, non-sensitive reason.
 * @throws An Error with a controlled diagnostic when an API request fails or a merge is not confirmed.
 * @remarks This owner never checks out pull-request code, retries a merge, approves a request or publishes a release. The caller supplies GH_TOKEN for the built-in GitHub CLI boundary. The final REST request atomically guards the tested head SHA; GitHub's merge endpoint has no equivalent expected-base parameter, so main can still move after the final read.
 *
 * @internal
 */
export async function mergeDependabotPullRequest(context, dependencies = {}) {
  const runId = positiveInteger(context?.runId);
  const runAttempt = positiveInteger(context?.runAttempt);

  if (context?.eventName !== 'workflow_run' || runId === undefined || runAttempt === undefined)
    return skipped('unsupported-context');

  const boundary = dependencies.request ?? requestDependabotGitHub;
  const request = async (method, endpoint, body) => {
    try {
      return await boundary(method, endpoint, body);
    } catch {
      throw new Error(requestFailure);
    }
  };
  const identity = await resolveDependabotRepository(context, request);

  if (!identity) return skipped('unsupported-repository');

  const repositoryPath = identity.path;
  const workflow = await request('GET', `${repositoryPath}/actions/workflows/ci.yml`);

  if (
    positiveInteger(workflow?.id) === undefined ||
    workflow?.path !== workflowPath ||
    workflow?.name !== workflowName
  )
    return skipped('unexpected-workflow');

  const runPath = `${repositoryPath}/actions/runs/${runId}`;
  const run = await request('GET', runPath);

  if (!eligibleRun(run, workflow, runId, runAttempt, identity))
    return skipped('ineligible-workflow-run');

  const pullRequestNumber = associatedPullRequest(run);

  if (pullRequestNumber === undefined) return skipped('ambiguous-pull-request');

  const pullRequestPath = `${repositoryPath}/pulls/${pullRequestNumber}`;
  const pullRequest = await request('GET', pullRequestPath);

  if (!eligiblePullRequest(pullRequest, pullRequestNumber, run, identity))
    return skipped('ineligible-pull-request');

  if (!(await successfulJobs(request, runId, runAttempt, repositoryPath)))
    return skipped('incomplete-verification');

  const mainPath = `${repositoryPath}/branches/${encodeURIComponent(identity.defaultBranch)}`;
  const main = await request('GET', mainPath);
  const mainSha = main?.commit?.sha;

  if (main?.name !== identity.defaultBranch || !shaPattern.test(mainSha ?? ''))
    return skipped('invalid-main');

  const comparison = await request('GET', `${repositoryPath}/compare/${mainSha}...${run.head_sha}`);

  if (comparison?.behind_by !== 0 || comparison?.merge_base_commit?.sha !== mainSha)
    return skipped('branch-not-current');

  const currentPullRequest = await request('GET', pullRequestPath);
  const currentRun = await request('GET', runPath);
  const currentMain = await request('GET', mainPath);

  if (
    !eligiblePullRequest(currentPullRequest, pullRequestNumber, run, identity) ||
    currentPullRequest?.base?.sha !== pullRequest.base.sha
  )
    return skipped('pull-request-changed');

  if (
    !eligibleRun(currentRun, workflow, runId, runAttempt, identity) ||
    currentRun.head_sha !== run.head_sha ||
    associatedPullRequest(currentRun) !== pullRequestNumber
  )
    return skipped('workflow-run-changed');

  if (currentMain?.name !== identity.defaultBranch || currentMain?.commit?.sha !== mainSha)
    return skipped('main-changed');

  const result = await request('PUT', `${pullRequestPath}/merge`, {
    sha: run.head_sha,
    merge_method: 'squash',
  });

  if (result?.merged !== true || !shaPattern.test(result?.sha ?? ''))
    throw new Error(
      'GitHub did not confirm the Dependabot pull request merge; inspect it before retrying.',
    );

  return {
    status: 'merged',
    pullRequestNumber,
    sha: result.sha,
    defaultBranch: identity.defaultBranch,
  };
}

function skipped(reason) {
  return { status: 'skipped', reason };
}

function positiveInteger(value) {
  const integer = typeof value === 'string' && /^[1-9]\d*$/u.test(value) ? Number(value) : value;

  return Number.isSafeInteger(integer) && integer > 0 ? integer : undefined;
}

function canonicalRepository(value, identity) {
  return value?.id === identity.id && value?.full_name === identity.fullName;
}

function eligibleRun(run, workflow, runId, runAttempt, identity) {
  return (
    run?.id === runId &&
    run?.run_attempt === runAttempt &&
    run?.event === 'pull_request' &&
    run?.status === 'completed' &&
    run?.conclusion === 'success' &&
    run?.workflow_id === workflow.id &&
    run?.name === workflow.name &&
    typeof run?.path === 'string' &&
    (run.path === workflowPath ||
      (run.path.startsWith(`${workflowPath}@`) && run.path.length > workflowPath.length + 1)) &&
    canonicalRepository(run?.repository, identity) &&
    canonicalRepository(run?.head_repository, identity) &&
    shaPattern.test(run?.head_sha ?? '')
  );
}

function associatedPullRequest(run) {
  if (!Array.isArray(run?.pull_requests) || run.pull_requests.length !== 1) return undefined;

  return positiveInteger(run.pull_requests[0]?.number);
}

function eligiblePullRequest(pullRequest, number, run, identity) {
  return (
    pullRequest?.number === number &&
    pullRequest?.state === 'open' &&
    pullRequest?.draft === false &&
    pullRequest?.merged === false &&
    pullRequest?.user?.login === 'dependabot[bot]' &&
    pullRequest?.user?.type === 'Bot' &&
    canonicalRepository(pullRequest?.head?.repo, identity) &&
    canonicalRepository(pullRequest?.base?.repo, identity) &&
    pullRequest?.base?.ref === identity.defaultBranch &&
    shaPattern.test(pullRequest?.base?.sha ?? '') &&
    pullRequest?.head?.sha === run.head_sha
  );
}

async function successfulJobs(request, runId, runAttempt, repositoryPath) {
  const jobs = [];
  let total;

  for (let page = 1; page <= 10; page++) {
    const response = await request(
      'GET',
      `${repositoryPath}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100&page=${page}`,
    );

    if (
      !Number.isSafeInteger(response?.total_count) ||
      response.total_count < 0 ||
      response.total_count > 1_000 ||
      !Array.isArray(response?.jobs) ||
      response.jobs.length > 100 ||
      (total !== undefined && response.total_count !== total)
    )
      return false;

    total = response.total_count;
    jobs.push(...response.jobs);

    if (jobs.length > total) return false;

    if (jobs.length === total) break;

    if (response.jobs.length === 0) return false;
  }

  if (jobs.length !== total || jobs.length !== requiredJobs.length) return false;

  const remaining = new Set(requiredJobs);
  const identifiers = new Set();

  for (const job of jobs) {
    if (
      positiveInteger(job?.id) === undefined ||
      identifiers.has(job.id) ||
      !remaining.delete(job?.name) ||
      job?.run_id !== runId ||
      (job?.run_attempt !== undefined && job.run_attempt !== runAttempt) ||
      job?.status !== 'completed' ||
      job?.conclusion !== 'success'
    )
      return false;

    identifiers.add(job.id);
  }

  return remaining.size === 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2)
      throw new Error('Dependabot merge accepts only its workflow_run environment.');

    const result = await mergeDependabotPullRequest({
      eventName: process.env.GITHUB_EVENT_NAME,
      repository: process.env.GITHUB_REPOSITORY,
      repositoryId: process.env.GITHUB_REPOSITORY_ID,
      defaultBranch: process.env.DEFAULT_BRANCH,
      runId: process.env.WORKFLOW_RUN_ID,
      runAttempt: process.env.WORKFLOW_RUN_ATTEMPT,
    });

    if (process.env.GITHUB_OUTPUT)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `merged=${result.status === 'merged'}\n${result.status === 'merged' ? `merge_sha=${result.sha}\ndefault_branch=${result.defaultBranch}\n` : ''}`,
        'utf8',
      );

    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write('Dependabot merge failed; inspect the workflow and pull request.\n');
    process.exitCode = 1;
  }
}
