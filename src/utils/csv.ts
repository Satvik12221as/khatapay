import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function readCSV(file: string): string[][] {
  const content = readFileSync(file, "utf8").trim();
  if (!content) return [];
  const lines = content.split(/\r?\n/);
  return lines.map((l) => l.split(",").map((c) => c.trim()));
}