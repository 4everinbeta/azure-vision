import { describe, expect, it } from "vitest";
import { buildElkGraph, computeLayout } from "./layout";

const nodes = [
  { id: "db", width: 100, height: 50, partition: 3 },
  { id: "app", width: 100, height: 50, partition: 2 },
];
const edges = [{ id: "e1", source: "app", target: "db" }, { id: "e2", source: "app", target: "gone" }];

describe("layout", () => {
  it("partitions nodes and drops edges to missing nodes", () => {
    const g = buildElkGraph({ nodes, edges });
    expect(g.children.map((c) => c.layoutOptions["elk.partitioning.partition"])).toEqual(["3", "2"]);
    expect(g.edges.map((e) => e.id)).toEqual(["e1"]);
  });
  it("places lower partitions to the left", async () => {
    const pos = await computeLayout({ nodes, edges });
    expect(pos.app.x).toBeLessThan(pos.db.x);
  });
});
