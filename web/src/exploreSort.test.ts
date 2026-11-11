import { describe, expect, it } from "vitest";
import { compareExplore, readSort } from "./exploreSort";

describe("Explore sorting", () => {
  const entries = [{ id: "z", name: "z", spend: 0 }, { id: "a", name: "a", spend: 20 }, { id: "m", name: "m" }];
  it("sorts spend in both directions with missing values last", () => {
    expect([...entries].sort((a, b) => compareExplore(a, b, { key: "spend", direction: "desc" })).map((e) => e.id)).toEqual(["a", "z", "m"]);
    expect([...entries].sort((a, b) => compareExplore(a, b, { key: "spend", direction: "asc" })).map((e) => e.id)).toEqual(["z", "a", "m"]);
  });
  it("uses natural name ordering and stable tie breaks", () => {
    expect(compareExplore({ id: "a", name: "vm2" }, { id: "b", name: "vm10" }, { key: "name", direction: "asc" })).toBeLessThan(0);
    expect(compareExplore({ id: "a", name: "same", count: 3 }, { id: "b", name: "same", count: 3 }, { key: "count", direction: "desc" })).toBeLessThan(0);
  });
  it("validates URL options for each presentation", () => {
    expect(readSort(new URLSearchParams("sort=type&order=bad"), false)).toEqual({ key: "name", direction: "asc" });
    expect(readSort(new URLSearchParams("sort=spend"), false)).toEqual({ key: "spend", direction: "desc" });
    expect(readSort(new URLSearchParams("resourceSort=location&resourceOrder=desc"), true)).toEqual({ key: "location", direction: "desc" });
  });
});
