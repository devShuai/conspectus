import type { LocalCollector } from "../types.js";

const registry: LocalCollector[] = [];

export function registerCollector(collector: LocalCollector): void {
  registry.push(collector);
}

export function listCollectors(): LocalCollector[] {
  return [...registry];
}
