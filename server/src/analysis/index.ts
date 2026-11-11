import type { Finding, Inventory, Rule } from "@azure-vision/shared";

// Register rules here (misconfiguration, underuse, cost/perf/best-practice). Empty in MVP.
export const rules: Rule[] = [];

export const analyze = (inv: Inventory): Finding[] => rules.flatMap((r) => r.evaluate(inv));
