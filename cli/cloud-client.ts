import {
  EXTENSION_BUNDLE_MEDIA_TYPE,
  type ExtensionBundle,
} from "../runtime/extension-bundle.ts";

export type PublishReleaseResult = {
  readonly extensionId: string;
  readonly version: string;
  readonly status: "DRAFT";
  readonly releaseId: string;
};

export type CloudPublicationScope = "system" | "tenant";

export type PublisherTrust = {
  readonly publisher: string;
  readonly keyId: string;
  readonly publicKey: JsonWebKey;
};

export class CloudClient {
  constructor(
    private readonly baseUrl: string,
    private readonly accessToken: string,
    private readonly scope: CloudPublicationScope,
    private readonly request: typeof fetch = fetch,
  ) {}

  async publish(
    bundle: ExtensionBundle,
    trust: PublisherTrust,
  ): Promise<PublishReleaseResult> {
    const manifest = manifestFrom(bundle);
    if (this.scope === "system" && manifest.publisher !== "FLAMOX365") {
      throw new Error(
        "Platform Extension Store packages must be published by FLAMOX365.",
      );
    }
    if (
      trust.publisher !== bundle.release.publisher ||
      trust.keyId !== bundle.release.publisherKeyId
    ) {
      throw new Error("Publisher trust does not match the signed bundle.");
    }
    const root = this.scope === "system"
      ? "/api/v1/system/edge/store"
      : "/api/v1/edge";
    await this.json(`${root}/publishers`, {
      publisher: trust.publisher,
      keyId: trust.keyId,
      publicKey: trust.publicKey,
    });
    const form = new FormData();
    form.append(
      "file",
      new Blob([`${JSON.stringify(bundle)}\n`], {
        type: EXTENSION_BUNDLE_MEDIA_TYPE,
      }),
      `${manifest.id}-${manifest.version}.fmx`,
    );
    const response = await this.request(
      `${this.baseUrl}${root}/releases`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.accessToken}` },
        body: form,
      },
    );
    const release = await responseData(response, "release upload");
    if (
      typeof release.id !== "string" ||
      release.version !== manifest.version ||
      release.status !== "DRAFT"
    ) {
      throw new Error("FLAMOX365 returned an invalid release response.");
    }
    return {
      extensionId: manifest.id,
      version: release.version,
      status: release.status,
      releaseId: release.id,
    };
  }

  private async json(
    path: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const response = await this.request(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return await responseData(response, path);
  }
}

async function responseData(
  response: Response,
  operation: string,
): Promise<Record<string, unknown>> {
  if (!response.ok) {
    const body = (await response.text()).slice(0, 2_000);
    throw new Error(
      `FLAMOX365 rejected ${operation} (${response.status}): ${
        body || response.statusText
      }`,
    );
  }
  const value: unknown = await response.json();
  if (
    !isRecord(value) || value.success !== true || !isRecord(value.data)
  ) {
    throw new Error(`FLAMOX365 returned an invalid response for ${operation}.`);
  }
  return value.data;
}

function manifestFrom(bundle: ExtensionBundle): {
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly description: string;
  readonly publisher: string;
} {
  const manifestFile = bundle.files.find((file) =>
    file.path === "extension-manifest.json"
  );
  if (!manifestFile) {
    throw new Error("Extension bundle does not contain its manifest.");
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder().decode(decodeBase64(manifestFile.contentBase64)),
    );
  } catch (error) {
    throw new Error("Extension bundle manifest is invalid.", { cause: error });
  }
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.version !== "string" ||
    typeof value.displayName !== "string" ||
    typeof value.description !== "string" ||
    typeof value.publisher !== "string"
  ) {
    throw new Error("Extension bundle manifest metadata is incomplete.");
  }
  return {
    id: value.id,
    version: value.version,
    displayName: value.displayName,
    description: value.description,
    publisher: value.publisher,
  };
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  let binary: string;
  try {
    binary = atob(value);
  } catch (error) {
    throw new Error("Extension bundle contains invalid base64.", {
      cause: error,
    });
  }
  return Uint8Array.from(
    binary,
    (character) => character.charCodeAt(0),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
