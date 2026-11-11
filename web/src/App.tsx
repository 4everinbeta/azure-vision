import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Background, Controls, MiniMap, Panel, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node } from "@xyflow/react";
import { toPng } from "html-to-image";
import {
  applyFilters, costPeriods, costRollup, emptyFilters, exploreFacets, filterExplore, formatCost, isCostPeriod, matchingCostRollup, rgKey, roleLabels, roleOrder,
  type CostData, type CostPeriod, type Filters, type Inventory, type Resource, type TypeMatch,
} from "@azure-vision/shared";
import { authHeaders, initAuth, type ServerConfig } from "./auth";
import { layoutResourceGroup } from "./elkLayout";
import { FilterPanel } from "./components/FilterPanel";
import { DetailsPanel, type ResourceCost } from "./components/DetailsPanel";
import { Overview, type Nav } from "./components/Overview";
import { SignIn, type AuthStatus } from "./components/SignIn";
import { layoutNetwork } from "./networkLayout";
import { CardNode, VNetNode, roleColors } from "./components/nodes";
import { decorateNodes, type CostView } from "./costView";
import { ExploreToolbar, SortControl } from "./components/ExploreToolbar";
import { ResourceList } from "./components/ResourceList";
import { defaultSort, readSort, type SortPrefs } from "./exploreSort";

const nodeTypes = { card: CardNode, vnet: VNetNode };

type View = "explore" | "network";
interface CostPrefs { period?: CostPeriod; heat: boolean } // period undefined = costs off
type Theme = "light" | "dark";

const params = () => new URLSearchParams(window.location.search);
const readFilters = (): Filters => {
  const q = params();
  const list = (k: string) => q.get(k)?.split(",").filter(Boolean) ?? [];
  return { subscriptions: list("sub"), resourceGroups: list("rg"), types: list("type"), search: q.get("q") ?? "" };
};
const readView = (): View => (params().get("view") === "network" ? "network" : "explore");
const readNav = (): Nav => ({ sub: params().get("s") ?? undefined, rg: params().get("g") ?? undefined });
const readCostPrefs = (): CostPrefs => {
  const p = params().get("cost");
  return { period: isCostPeriod(p) ? p : undefined, heat: params().get("heat") === "1" };
};
const readTheme = (): Theme =>
  (localStorage.getItem("theme") as Theme | null) ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

const writeUrl = (f: Filters, view: View, cost: CostPrefs, nav: Nav, match: TypeMatch, sort: SortPrefs, resourceSort: SortPrefs, presentation: "diagram" | "list") => {
  const q = new URLSearchParams();
  if (view === "network") q.set("view", "network");
  if (view === "explore" && nav.sub) q.set("s", nav.sub);
  if (view === "explore" && nav.rg) q.set("g", nav.rg);
  if (cost.period) q.set("cost", cost.period);
  if (cost.period && cost.heat) q.set("heat", "1");
  if (f.subscriptions.length) q.set("sub", f.subscriptions.join(","));
  if (f.resourceGroups.length) q.set("rg", f.resourceGroups.join(","));
  if (f.types.length) q.set("type", f.types.join(","));
  if (f.search) q.set("q", f.search);
  if (match === "all") q.set("match", match);
  if (sort.key !== "name" || sort.direction !== "asc") { q.set("sort", sort.key); q.set("order", sort.direction); }
  if (resourceSort.key !== "name" || resourceSort.direction !== "asc") { q.set("resourceSort", resourceSort.key); q.set("resourceOrder", resourceSort.direction); }
  if (presentation === "list") q.set("presentation", presentation);
  const s = q.toString();
  window.history.replaceState(null, "", s ? `?${s}` : window.location.pathname);
};

/** Dim everything except the selected card, its neighbours and the edges between them. */
function highlight(nodes: Node[], edges: Edge[], selectedId?: string): { nodes: Node[]; edges: Edge[] } {
  if (!selectedId) return { nodes, edges };
  const near = new Set([selectedId]);
  for (const e of edges) {
    if (e.source === selectedId) near.add(e.target);
    if (e.target === selectedId) near.add(e.source);
  }
  return {
    nodes: nodes.map((n) => (near.has(n.id) ? n : { ...n, data: { ...n.data, dim: true } })),
    edges: edges.map((e) => (e.source === selectedId || e.target === selectedId ? { ...e, className: "hl" } : { ...e, className: "dim" })),
  };
}

function Canvas({ inv, view, cost, selectedId, theme, onSelect }: {
  inv: Inventory; view: View; cost?: CostView; selectedId?: string; theme: Theme; onSelect: (r?: Resource, children?: Resource[]) => void;
}) {
  const [layout, setLayout] = useState<{ nodes: Node[]; edges: Edge[]; legend?: { subscription: string; color: string }[] }>();
  const [busy, setBusy] = useState(false);
  const [layoutError, setLayoutError] = useState<string>();
  useEffect(() => {
    let live = true;
    setBusy(true);
    setLayoutError(undefined);
    (async () => (view === "network" ? layoutNetwork(inv) : layoutResourceGroup(inv)))()
      .then((l) => { if (live) { setLayout(l); setBusy(false); } })
      .catch((e) => { if (live) { setLayoutError((e as Error).message); setBusy(false); } });
    return () => { live = false; };
  }, [inv, view]);

  const shown = useMemo(() => {
    if (!layout) return { nodes: [] as Node[], edges: [] as Edge[] };
    const nodes = cost ? decorateNodes(layout.nodes, cost) : layout.nodes;
    return highlight(nodes, layout.edges, selectedId);
  }, [layout, cost, selectedId]);

  const { fitView } = useReactFlow();
  useEffect(() => {
    const t = setTimeout(() => fitView({ duration: 300, padding: 0.15 }), 50);
    return () => clearTimeout(t);
  }, [layout, fitView]);

  const exportPng = async () => {
    const el = document.querySelector<HTMLElement>(".react-flow__viewport");
    if (!el) return;
    const url = await toPng(el, { backgroundColor: theme === "dark" ? "#11151a" : "#f3f2f1", pixelRatio: 2 });
    Object.assign(document.createElement("a"), { href: url, download: "azure-vision.png" }).click();
  };

  const roles = [...new Set(inv.resources.map((r) => r.type))].length ? roleOrder : [];
  return (
    <>
      {busy && <div className="busy">Laying out…</div>}
      {layoutError && <div className="error">Layout failed: {layoutError}</div>}
      <ReactFlow
        nodes={shown.nodes} edges={shown.edges} nodeTypes={nodeTypes} colorMode={theme}
        nodesDraggable={false} nodesConnectable={false} minZoom={0.05} maxZoom={2} onlyRenderVisibleElements
        onNodeClick={(_, n) => { const d = n.data as { resource?: Resource; children?: Resource[] }; onSelect(d.resource, d.children); }}
        onPaneClick={() => onSelect(undefined)}
      >
        <Background />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable />
        <Panel position="top-right"><button onClick={exportPng}>Export PNG</button></Panel>
        {view === "explore" && (
          <Panel position="top-left" className="rolekey">
            {roles.map((r) => <span key={r}><i style={{ background: roleColors[r] }} />{roleLabels[r]}</span>)}
          </Panel>
        )}
        {layout?.legend?.length ? (
          <Panel position="top-left" className="legend">
            {layout.legend.map((l) => <div key={l.subscription}><i style={{ background: l.color }} /> {l.subscription}</div>)}
          </Panel>
        ) : null}
      </ReactFlow>
    </>
  );
}

export function App() {
  const [inv, setInv] = useState<Inventory>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<Filters>(() => readView() === "explore" ? readFilters() : emptyFilters);
  const [networkFilters, setNetworkFilters] = useState<Filters>(() => readView() === "network" ? readFilters() : emptyFilters);
  const [typeMatch, setTypeMatch] = useState<TypeMatch>(() => params().get("match") === "all" ? "all" : "any");
  const [sort, setSort] = useState<SortPrefs>(() => readSort(params(), false));
  const [resourceSort, setResourceSort] = useState<SortPrefs>(() => readSort(params(), true));
  const [presentation, setPresentation] = useState<"diagram" | "list">(() => params().get("presentation") === "list" ? "list" : "diagram");
  const [selected, setSelected] = useState<Resource>();
  const [selectedKids, setSelectedKids] = useState<Resource[]>([]);
  const select = (r?: Resource, kids: Resource[] = []) => { setSelected(r); setSelectedKids(kids); };
  const [auth, setAuth] = useState<AuthStatus>();
  const [hosted, setHosted] = useState<{ user?: string }>();
  const [needsLogin, setNeedsLogin] = useState(false);
  const [view, setView] = useState<View>(readView);
  const [nav, setNav] = useState<Nav>(readNav);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [costPrefs, setCostPrefs] = useState<CostPrefs>(readCostPrefs);
  const [costs, setCosts] = useState<CostData>();
  const [costError, setCostError] = useState<string>();
  const [costLoading, setCostLoading] = useState(false);
  const forceCosts = useRef(false);
  const [costTick, setCostTick] = useState(0); // bumped to poll while the server is still collecting

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(undefined);
    try {
      const cfg: ServerConfig = await (await fetch("/api/config")).json();
      await initAuth(cfg);
      setHosted(cfg.source === "managed" ? { user: cfg.user } : undefined);
      if (cfg.source === "local") {
        const a: AuthStatus = await (await fetch("/api/auth/status")).json();
        setAuth(a);
        if (!a.signedIn) { setNeedsLogin(true); return; }
      }
      setNeedsLogin(false);
      if (refresh) forceCosts.current = true;
      const res = await fetch(`/api/inventory${refresh ? "?refresh=1" : ""}`, { headers: await authHeaders() });
      if (res.status === 401 && cfg.source === "local") { setInv(undefined); setNeedsLogin(true); return; }
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setInv(await res.json());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => writeUrl(view === "explore" ? filters : networkFilters, view, costPrefs, nav, typeMatch, sort, resourceSort, presentation),
    [filters, networkFilters, view, costPrefs, nav, typeMatch, sort, resourceSort, presentation]);

  const costPeriod = costPrefs.period;
  useEffect(() => {
    if (!inv || !costPeriod) { setCosts(undefined); setCostError(undefined); return; }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = forceCosts.current;
    forceCosts.current = false;
    setCostLoading(true);
    setCostError(undefined);
    (async () => {
      const res = await fetch(`/api/costs?period=${costPeriod}${refresh ? "&refresh=1" : ""}`, { headers: await authHeaders() });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      const data: CostData = await res.json();
      if (live) {
        setCosts(data);
        if (data.pending) timer = setTimeout(() => setCostTick((t) => t + 1), 4000);
      }
    })()
      .catch((e) => { if (live) { setCosts(undefined); setCostError((e as Error).message); } })
      .finally(() => { if (live) setCostLoading(false); });
    return () => { live = false; clearTimeout(timer); };
  }, [inv, costPeriod, costTick]);

  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setInv(undefined);
    setAuth(undefined);
    setNeedsLogin(true);
  };

  const filtered = useMemo(() => inv ? view === "explore" ? filterExplore(inv, filters, nav, typeMatch) : applyFilters(inv, networkFilters) : undefined,
    [inv, filters, networkFilters, view, nav, typeMatch]);
  const activeFilters = view === "explore" ? filters : networkFilters;
  const active = !!(activeFilters.search.trim() || activeFilters.subscriptions.length || activeFilters.resourceGroups.length || activeFilters.types.length);
  const facets = useMemo(() => inv ? exploreFacets(inv, filters, nav, typeMatch) : undefined, [inv, filters, nav, typeMatch]);
  const scopeTotal = useMemo(() => inv ? filterExplore(inv, emptyFilters, nav, "any").resources.length : 0, [inv, nav]);

  useEffect(() => {
    if (selected && filtered && !filtered.resources.some((r) => r.id === selected.id)) {
      setSelected(undefined);
      setSelectedKids([]);
    }
  }, [filtered, selected]);

  const rollup = useMemo(() => (inv && costs ? costRollup(inv.resources, costs) : undefined), [inv, costs]);
  const summaryRollup = useMemo(() => view === "explore" && active && filtered && costs
    ? matchingCostRollup(filtered.resources, costs) : rollup, [view, active, filtered, costs, rollup]);
  const costView = useMemo<CostView | undefined>(
    () => (summaryRollup && costs ? { rollup: summaryRollup, currency: costs.currency, heat: costPrefs.heat } : undefined),
    [summaryRollup, costs, costPrefs.heat],
  );
  const selectedCost = useMemo<ResourceCost | undefined>(() => {
    if (!rollup || !costs || !selected) return undefined;
    return {
      period: costs.period, periodLabel: `${costPeriods.find((p) => p.id === costs.period)!.label} (${costs.from} to ${costs.to})`,
      currency: costs.currency, value: rollup.resource.get(selected.id),
      rgTotal: rollup.resourceGroup.get(rgKey(selected)),
      subTotal: rollup.subscription.get(selected.subscriptionId),
    };
  }, [rollup, costs, selected]);

  const open = (n: Nav) => { setNav(n); select(undefined); };
  const subName = inv?.resources.find((r) => r.subscriptionId === nav.sub)?.subscriptionName ?? nav.sub;
  const rgName = inv?.resources.find((r) => rgKey(r) === nav.rg)?.resourceGroup ?? nav.rg;
  const showOverview = view === "explore" && !nav.rg;
  const chosenSort = showOverview ? sort : resourceSort;
  const spendAvailable = !!costPeriod && !!summaryRollup && (showOverview
    ? !!(nav.sub ? summaryRollup.resourceGroup.size : summaryRollup.subscription.size) : !!summaryRollup.resource.size);
  const effectiveSort = chosenSort.key === "spend" && !spendAvailable ? defaultSort : chosenSort;
  const summaryTotal = view !== "explore" ? summaryRollup?.total : active ? summaryRollup?.resource.size ? summaryRollup.total : undefined
    : nav.rg ? summaryRollup?.resourceGroup.get(nav.rg) : nav.sub ? summaryRollup?.subscription.get(nav.sub) : summaryRollup?.total;

  return (
    <div className="app">
      <header>
        <strong>Azure Vision</strong>
        <div className="tabs">
          {(["explore", "network"] as const).map((v) => (
            <button key={v} className={view === v ? "active" : ""} onClick={() => { setView(v); setSelected(undefined); }}>
              {v === "explore" ? "Explore" : "Network"}
            </button>
          ))}
        </div>
        {inv && <span title="Cached for 24h; Refresh forces a new query">Data from {new Date(inv.fetchedAt).toLocaleString()}</span>}
        {view === "network" && filtered && inv && <span>{filtered.resources.length} / {inv.resources.length} resources</span>}
        {view === "network" && active && <button onClick={() => setNetworkFilters(emptyFilters)}>Reset filters</button>}
        {hosted && <span>{hosted.user}</span>}
        {hosted && <a href="/.auth/logout">Sign out</a>}
        {auth?.signedIn && <span>{auth.user}</span>}
        {auth?.signedIn && <button onClick={signOut}>Sign out</button>}
        <label title="Overlay Azure Cost Management data">
          <input type="checkbox" checked={!!costPeriod}
            onChange={(e) => setCostPrefs((p) => ({ ...p, period: e.target.checked ? "mtd" : undefined }))} />
          Costs
        </label>
        {costPeriod && (
          <>
            <select value={costPeriod} onChange={(e) => setCostPrefs((p) => ({ ...p, period: e.target.value as CostPeriod }))}>
              {costPeriods.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <label>
              <input type="checkbox" checked={costPrefs.heat} onChange={(e) => setCostPrefs((p) => ({ ...p, heat: e.target.checked }))} />
              Heat
            </label>
            {costLoading && !costs && <span>Loading costs…</span>}
            {!!costs?.pending && <span title="Cost Management throttles requests, so subscriptions are fetched one at a time and cached for 24h">Fetching {costs.pending} more subscription(s)…</span>}
            {summaryRollup && costs && (
              <span title={`${costs.from} to ${costs.to}; cost data lags by several hours`}>
                {view === "explore" && active ? "Matching resource spend" : "Total"} {summaryTotal === undefined ? "unavailable" : formatCost(summaryTotal, costs.currency)}
                {costs.pending || costs.warnings.length ? " (partial)" : ""}
              </span>
            )}
          </>
        )}
        <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")} title="Toggle dark mode">{theme === "dark" ? "☀ Light" : "☾ Dark"}</button>
        <button onClick={() => load(true)} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
      </header>
      {needsLogin && <SignIn onSignedIn={() => load()} />}
      {error && <div className="error">Failed to load inventory: {error}</div>}
      {costError && <div className="error">Failed to load costs: {costError}</div>}
      {costs?.warnings.length && !costs.pending ? (
        <div className="warning">
          Costs are incomplete: {costs.warnings.length} subscription(s) could not be queried (throttled, or Cost Management Reader is missing). They are retried on the next load; Refresh forces a re-query.
          <details><summary>Details</summary>{costs.warnings.map((w) => <div key={w}>{w}</div>)}</details>
        </div>
      ) : null}
      {inv && filtered && (
        <>
          {view === "explore" && (
            <nav className="crumbs">
              <button className="link" onClick={() => open({})}>All subscriptions</button>
              {nav.sub && <><span className="sep">›</span><button className="link" onClick={() => open({ sub: nav.sub })}>{subName}</button></>}
              {nav.rg && <><span className="sep">›</span><strong>{rgName}</strong></>}
            </nav>
          )}
          {view === "explore" && facets && (
            <>
              <ExploreToolbar filters={filters} facets={facets} match={typeMatch} onMatch={setTypeMatch}
                onChange={setFilters} onReset={() => setFilters(emptyFilters)} count={filtered.resources.length} total={scopeTotal} />
              <div className="explore-view-tools">
                {typeMatch === "all" && filters.types.length > 1 && <span className="note">
                  All selected types must occur in {nav.sub || nav.rg ? "the same resource group" : "each subscription"}.
                </span>}
                {nav.rg && <div className="presentation-toggle" aria-label="Resource presentation">
                  <button aria-pressed={presentation === "diagram"} onClick={() => setPresentation("diagram")}>Diagram</button>
                  <button aria-pressed={presentation === "list"} onClick={() => setPresentation("list")}>List</button>
                </div>}
                {(showOverview || presentation === "list") && <SortControl value={chosenSort} resourceList={!showOverview}
                  costsEnabled={!!costPeriod} onChange={showOverview ? setSort : setResourceSort} />}
                {chosenSort.key === "spend" && !spendAvailable && (showOverview || presentation === "list") &&
                  <span className="note">Name order until spend is available.</span>}
              </div>
            </>
          )}
          <main>
            {view === "network" && <FilterPanel inv={inv} filters={networkFilters} onChange={setNetworkFilters} />}
            <div className="canvas">
              {view === "explore" && !filtered.resources.length ? (
                <div className="empty-results">
                  <h3>No resources match in {rgName ?? subName ?? "all subscriptions"}.</h3>
                  <p>Clear filters or use the breadcrumbs to change scope.</p>
                  {active && <button onClick={() => setFilters(emptyFilters)}>Reset filters</button>}
                </div>
              ) : showOverview ? (
                <Overview inv={filtered} nav={nav} rollup={summaryRollup} currency={costPeriod ? costs?.currency : undefined} sort={effectiveSort} onOpen={open} />
              ) : view === "explore" && presentation === "list" ? (
                <ResourceList inv={filtered} rollup={summaryRollup} currency={costPeriod ? costs?.currency : undefined}
                  sort={effectiveSort} selectedId={selected?.id} onSelect={(r) => select(r)} />
              ) : (
                <ReactFlowProvider>
                  <Canvas inv={filtered} view={view} cost={costView} selectedId={selected?.id} theme={theme} onSelect={select} />
                </ReactFlowProvider>
              )}
            </div>
            {selected && !showOverview && <DetailsPanel resource={selected} children={selectedKids} cost={selectedCost} onClose={() => setSelected(undefined)} />}
          </main>
        </>
      )}
    </div>
  );
}
