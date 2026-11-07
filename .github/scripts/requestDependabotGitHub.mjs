// #region Imports

import { execFile } from 'node:child_process';

// #endregion

const requestFailure =
  'Dependabot GitHub API request failed; inspect the workflow and pull request before retrying.';

/**
 * Calls GitHub REST with the workflow's existing token and bounded native CLI execution.
 *
 * @param method - The HTTP method for the trusted repository operation.
 * @param endpoint - The repository-scoped REST endpoint constructed by the owning helper.
 * @param body - Optional JSON sent through standard input.
 * @returns The parsed JSON response.
 * @throws An Error with a controlled diagnostic when the token, command or response is unavailable.
 * @remarks Does not install tools, log in, discover credentials, print provider output or retry requests. Tokens stay in the child environment.
 *
 * @internal
 */
export async function requestDependabotGitHub(method, endpoint, body) {
  try {
    if (!process.env.GH_TOKEN) throw new Error(requestFailure);

    return await new Promise((resolveRequest, reject) => {
      const child = execFile(
        'gh',
        [
          'api',
          '--hostname',
          'github.com',
          '--method',
          method,
          '--header',
          'Accept: application/vnd.github+json',
          '--header',
          'X-GitHub-Api-Version: 2022-11-28',
          endpoint,
          ...(body === undefined ? [] : ['--input', '-']),
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, GH_PROMPT_DISABLED: '1' },
          maxBuffer: 1024 * 1024,
          timeout: 15_000,
          killSignal: 'SIGKILL',
          windowsHide: true,
        },
        (error, stdout) => {
          if (error) {
            reject(new Error(requestFailure));

            return;
          }

          try {
            resolveRequest(JSON.parse(stdout));
          } catch {
            reject(new Error(requestFailure));
          }
        },
      );

      child.stdin?.on('error', () => reject(new Error(requestFailure)));
      child.stdin?.end(body === undefined ? undefined : JSON.stringify(body));
    });
  } catch {
    throw new Error(requestFailure);
  }
}
