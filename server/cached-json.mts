import { promises as fs } from "node:fs";

export function createJsonCache() {
  const cache = new Map<string, { signature: string; value: unknown }>();
  const signature = (stat: import("node:fs").BigIntStats) =>
    `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  return {
    clear: () => cache.clear(),
    retain: (files: Set<string>) => { for (const file of cache.keys()) if (!files.has(file)) cache.delete(file); },
    async read(file: string, fallback: unknown): Promise<any> {
      try {
        const before = signature(await fs.stat(file, { bigint: true }));
        const hit = cache.get(file);
        if (hit?.signature === before) return structuredClone(hit.value);
        const value = JSON.parse(await fs.readFile(file, "utf8"));
        const after = signature(await fs.stat(file, { bigint: true }));
        if (before === after) cache.set(file, { signature: after, value: structuredClone(value) });
        else cache.delete(file);
        return value;
      } catch (error) {
        cache.delete(file);
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
        throw error;
      }
    },
  };
}
