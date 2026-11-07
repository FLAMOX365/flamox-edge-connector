import { stat } from "node:fs/promises";
import { win32 } from "node:path";

export async function windowsReadRoots(directory: string): Promise<string[]> {
  const roots = await Promise.all(
    Array.from({ length: 26 }, async (_, index) => {
      const root = `${String.fromCharCode(65 + index)}:\\`;
      try {
        await stat(root);
        return root;
      } catch {
        return undefined;
      }
    }),
  );
  return [
    ...new Set([
      ...roots.filter((root) => root !== undefined),
      win32.parse(directory).root,
    ]),
  ];
}
