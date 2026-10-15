/** Copies the bootstrap environment without introducing undefined values. */
export function environmentSnapshot(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined) values[name] = value;
  return values;
}
