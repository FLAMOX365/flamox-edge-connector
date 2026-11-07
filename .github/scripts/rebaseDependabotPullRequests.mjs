// #region Imports

import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { requestDependabotGitHub } from './requestDependabotGitHub.mjs';
import { resolveDependabotRepository } from './resolveDependabotRepository.mjs';

// #endregion

const shaPattern = /^[0-9a-f]{40}$/u;
const maximumPages = 10;
const pageSize = 100;
const requestFailure =
  'Dependabot rebase stopped after a GitHub API request failed; inspect the workflow before retrying.';

/**
 * Updates same-repository Dependabot branches through GitHub's branch API,
 * then explicitly dispatches CI because GITHUB_TOKEN writes do not start it.
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
  const result = { status: 'completed', mainSha, updated: [], dispatched: [], skipped: [] };
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

    const runs = await request('GET',
      `${repositoryPath}/actions/workflows/ci.yml/runs?branch=${encodeURIComponent(pullRequest.head.ref)}&head_sha=${pullRequest.head.sha}&per_page=100`,
    );
    if (!Array.isArray(runs?.workflow_runs)) throw new Error('Invalid CI run metadata.');
    if (runs.workflow_runs.some((run) => run.head_sha === pullRequest.head.sha)) {
      skip(number, 'verification-already-requested');
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
    await request('POST', `${repositoryPath}/actions/workflows/ci.yml/dispatches`, {
      ref: pullRequest.head.ref,
    });
    result.dispatched.push(number);
  }
  return result;
}

function eligiblePullRequest(value, number, identity) {
  return (
    value?.number === number &&
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

    const result = await rebaseDependabotPullRequests({
      repository: process.env.GITHUB_REPOSITORY,
      repositoryId: process.env.GITHUB_REPOSITORY_ID,
      defaultBranch: process.env.DEFAULT_BRANCH,
      eventName: process.env.GITHUB_EVENT_NAME,
      ref: process.env.GITHUB_REF,
    });

    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write('Dependabot rebase could not complete; inspect the workflow run.\n');
    process.exitCode = 1;
  }
}
