const registry = [];
export function registerCollector(collector) {
    registry.push(collector);
}
export function listCollectors() {
    return [...registry];
}
