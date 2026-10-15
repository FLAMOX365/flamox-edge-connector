import { environmentSnapshot } from "./environment.ts";
export interface ExtensionSecretProvider {
  resolve(
    extensionId: string,
    names: readonly string[],
  ): Promise<Readonly<Record<string, string>>>;
}

/** Resolves only explicitly granted extension secrets from the process environment. */
export class EnvironmentExtensionSecretProvider
  implements ExtensionSecretProvider
{
  readonly #environment: Readonly<Record<string, string | undefined>>;

  constructor(
    environment: Readonly<
      Record<string, string | undefined>
    > = environmentSnapshot(),
  ) {
    this.#environment = environment;
  }

  resolve(
    extensionId: string,
    names: readonly string[],
  ): Promise<Readonly<Record<string, string>>> {
    const result: Record<string, string> = {};
    for (const name of names) {
      const environmentName = extensionSecretEnvironmentName(extensionId, name);
      const value = this.#environment[environmentName];
      if (value === undefined || value.length === 0) {
        throw new Error(
          `Required local secret '${name}' is not configured for extension '${extensionId}'.`,
        );
      }
      result[name] = value;
    }
    return Promise.resolve(result);
  }
}

/** Tenant-scoped secrets delivered by Desired State; values never enter state. */
export class ManagedExtensionSecretProvider implements ExtensionSecretProvider {
  readonly #values = new Map<string, Readonly<Record<string, string>>>();

  constructor(private readonly fallback?: ExtensionSecretProvider) {}

  update(extensionId: string, secrets: Readonly<Record<string, string>>): void {
    const copy: Record<string, string> = {};
    for (const [name, value] of Object.entries(secrets)) {
      if (!/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u.test(name) || !value) {
        throw new Error("Managed extension secret set is invalid.");
      }
      copy[name] = value;
    }
    this.#values.set(extensionId, Object.freeze(copy));
  }

  remove(extensionId: string): void {
    this.#values.delete(extensionId);
  }

  async resolve(
    extensionId: string,
    names: readonly string[],
  ): Promise<Readonly<Record<string, string>>> {
    const configured = this.#values.get(extensionId);
    if (!configured) {
      if (this.fallback) return await this.fallback.resolve(extensionId, names);
      throw new Error(
        `Managed secrets are not available for extension '${extensionId}'.`,
      );
    }
    const result: Record<string, string> = {};
    for (const name of names) {
      const value = configured[name];
      if (!value) {
        throw new Error(
          `Required managed secret '${name}' is unavailable for extension '${extensionId}'.`,
        );
      }
      result[name] = value;
    }
    return result;
  }
}

export function extensionSecretEnvironmentName(
  extensionId: string,
  secretName: string,
): string {
  const normalizedId = extensionId.toUpperCase().replaceAll(/[^A-Z0-9]/gu, "_");
  return `EDGE_EXTENSION_${normalizedId}__${secretName}`;
}
