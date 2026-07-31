import type { ProtocolExecutor } from "./connector.ts";
import type { ExtensionProtocolExecutor } from "./extension-protocol-executor.ts";

/**
 * Additive execution seam: managed extension routes are isolated while every
 * other request keeps the original Functions/YAML/proxy behavior.
 */
export class ProtocolDispatcher implements ProtocolExecutor {
  constructor(
    private readonly extensions: ExtensionProtocolExecutor,
    private readonly legacy: ProtocolExecutor,
  ) {}

  execute: ProtocolExecutor["execute"] = (frame) => {
    return this.extensions.owns(frame)
      ? this.extensions.execute(frame)
      : this.legacy.execute(frame);
  };
}
