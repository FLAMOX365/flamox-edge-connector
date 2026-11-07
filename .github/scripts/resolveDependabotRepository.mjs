// #region Imports

const repositoryIdentity = {
  id: 1317851991,
  name: 'flamox-edge-connector',
  fullName: 'FLAMOX365/flamox-edge-connector',
  defaultBranch: 'main',
};

// #endregion

/**
 * Resolves the public repository by its immutable GitHub identity.
 *
 * @param context - The workflow's repository ID, current full name and default branch.
 * @param request - The parsed-JSON GitHub API boundary.
 * @returns The canonical repository, or undefined before the public cutover or for foreign metadata.
 * @remarks No privileged bot operation is enabled by a matching repository name alone.
 *
 * @internal
 */
export async function resolveDependabotRepository(context, request) {
  if (
    ![repositoryIdentity.id, String(repositoryIdentity.id)].includes(context?.repositoryId) ||
    context?.repository !== repositoryIdentity.fullName ||
    context?.defaultBranch !== repositoryIdentity.defaultBranch
  )
    return undefined;

  const repository = await request('GET', `repositories/${repositoryIdentity.id}`);

  if (
    repository?.id !== repositoryIdentity.id ||
    repository?.name !== repositoryIdentity.name ||
    repository?.full_name !== repositoryIdentity.fullName ||
    repository?.default_branch !== repositoryIdentity.defaultBranch ||
    repository?.fork !== false ||
    repository?.private !== false ||
    repository?.visibility !== 'public'
  )
    return undefined;

  return {
    id: repositoryIdentity.id,
    fullName: repositoryIdentity.fullName,
    defaultBranch: repositoryIdentity.defaultBranch,
    path: `repos/${repositoryIdentity.fullName}`,
  };
}
