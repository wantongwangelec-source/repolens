import type {
  Confidence,
  FileRole,
  GraphDto,
  GraphNodeDto,
  LensKind,
  OverviewDto,
  RepoEntry,
} from "@repolens/core/types";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { GraphSlice } from "../graph/model";
import { api, getActiveRepo, setActiveRepo, type WatchStatusDto } from "../api/client";
import { readPref, writePref } from "../lib/prefs";

export type MetricKey = "loc" | "complexity" | "symbols";

/** The picture viewing settings and the sidebar's open or closed state follow the user, and they remain the same next time it is opened; what you have viewed or selected does not count as a setting and is not remembered. */
const PREF = {
  metric: "repolens:metric",
  noise: "repolens:show-noise",
  external: "repolens:show-external",
  confidence: "repolens:call-confidence",
  callDepth: "repolens:call-depth",
  callDirection: "repolens:call-direction",
  walkAllCalls: "repolens:walk-all-calls",
  walkTrivial: "repolens:walk-show-trivial",
  walkMainPath: "repolens:walk-main-path",
  treeOpen: "repolens:left-panel-open",
  panelTab: "repolens:left-panel-tab",
  chatOpen: "repolens:chat-open",
  lens: "repolens:lens",
} as const;

const PANEL_TABS: readonly PanelTab[] = ["tree", "findings", "entries", "changes"];
const LENSES: readonly LensKind[] = ["heat", "tests"];

function savedChoice<T extends string>(key: string, choices: readonly T[], fallback: T): T {
  const value = readPref(key);
  return choices.includes(value as T) ? (value as T) : fallback;
}

function savedLens(): LensKind | null {
  const value = readPref(PREF.lens);
  return LENSES.includes(value as LensKind) ? (value as LensKind) : null;
}

function savedConfidence(): Confidence[] {
  const choices: Confidence[] = ["exact", "likely", "ambiguous", "external", "unresolved"];
  const saved = (readPref(PREF.confidence) ?? "").split(",").filter((value): value is Confidence =>
    choices.includes(value as Confidence));
  return saved.length > 0 ? saved : DEFAULT_CONFIDENCE;
}

export const SOURCE_ONLY_ROLES: FileRole[] = ["source"];
export const ALL_VISIBLE_ROLES: FileRole[] = ["source", "test", "config", "generated", "types"];

/**
 * The default number of child nodes displayed for each scope.
 *
 * The limit is not a performance issue but a readability issue: having 30 sibling nodes in one directory,
 * ELK will lay out the container to a width of six thousand pixels, then automatically scale it down to 0.3 after adaptation, turning all the text into noise.
 * 12 can be clearly read on one screen, and the rest are collected into an aggregated node, which the user can expand to view if they want.
 */
const BASE_LIMIT = 12;

/**
 * By default, only draw call edges that can be proven.
 *
 * ambiguous means 'there is more than one candidate with the same name, I picked the first one', mix it into the default view
 * It is just passing off guesses as facts. Those who want to see can open it themselves; at that time, it was clearly a deliberate choice.
 */
export const DEFAULT_CONFIDENCE: Confidence[] = ["exact", "likely"];

/** The call graph is stuffed into subgraphs as a composite scope, and the rendering layer does not need to know of its existence. */
const callScope = (symbolId: number) => `call:${symbolId}`;

/** The most recently processed index refresh */
let lastIndexAt: string | null = null;

export interface CallGraphMode {
  scopeId: string;
  symbolId: number;
  label: string;
  depth: number;
  direction: "callers" | "callees" | "both";
}

export type PanelTab = "tree" | "findings" | "entries" | "changes";

/** Walk through a frame in the call stack */
export interface WalkFrameRef {
  /** Function id, `sym:N` */
  id: string;
  /** Use it first for the previous top bar and breadcrumb before the frame data */
  name: string;
  /** Stop at which call (`call:N`); null means stop at the beginning of the function */
  at: string | null;
  /** The line where that call is located: after the index is refreshed, the call ID will change, use it to stop near the original place */
  line?: number | null;
}

export interface WalkState {
  /** Where to start from: entry name or function name */
  label: string;
  /** In the call stack starting from the entry point, the last frame is the function currently being viewed */
  stack: WalkFrameRef[];
}

export interface DetailRequest {
  nodeId: string;
  tab: "source" | "notes";
  lines: [number, number] | null;
}

export interface AppState {
  overview: OverviewDto | null;
  bootError: string | null;

  /** Scanned warehouse list, for top bar switching */
  repos: RepoEntry[];
  /** The ID of the currently browsed repository; null means the list has not been retrieved yet */
  repoId: string | null;
  /** There isn't a single repository in the list that can be opened, nor is there a repository that can be started. The desktop version is like this on the first launch. */
  noRepo: boolean;
  /** Increment each time 'Add Repository' is requested; the repository selector pops up the directory selection accordingly */
  addRepoRequest: number;
  requestAddRepo: () => void;
  /** Only re-fetch the overview, not the images. After changing the AI settings, use it to refresh the top bar status */
  refreshOverview: () => Promise<void>;
  /** Incremented when switching repositories or rescanning the current repository, used to invalidate the local view and asynchronous requests. */
  repoRevision: number;
  /**
   * The index increments when refreshed according to the latest files (watch or 'rescan and compare'). Unlike repoRevision,
   * The view state (expanded, selected, reading position) is all retained, only the data that has been fetched is refetched.
   */
  indexRevision: number;
  /** `at` is the time when the server-side refresh is completed: the same refresh is counted only once even if it returns from both events and interfaces. */
  refreshIndex: (at?: string) => Promise<void>;
  /** The file monitoring status of the current repository; null if no events are subscribed */
  watchStatus: WatchStatusDto | null;
  setWatchStatus: (status: WatchStatusDto | null) => void;
  /** Overlaid perspectives on the chart: change frequency, test coverage */
  lens: LensKind | null;
  setLens: (lens: LensKind | null) => void;
  refreshRepos: () => Promise<void>;
  switchRepo: (id: string, forceReload?: boolean) => Promise<void>;
  forgetRepo: (id: string) => Promise<void>;

  rootScope: string;
  /** A subgraph layer of each loaded scope */
  subgraphs: Record<string, GraphDto>;
  loadingScopes: string[];
  /** Requested a larger limit scope (after expanding the aggregation node) */
  scopeLimits: Record<string, number>;
  /** Node IDs that have been deployed in place, in order */
  expanded: string[];

  focus: string | null;
  focusDepth: number;

  selected: string | null;
  hovered: string | null;
  hoverAnchor: { x: number; y: number } | null;

  drawerOpen: boolean;
  /** Follow-up AI panel. Shares the right sidebar with the details drawer: docks below the details when an item is selected, occupies it alone when none is selected. */
  chatOpen: boolean;
  treeOpen: boolean;
  filterOpen: boolean;
  paletteOpen: boolean;
  helpOpen: boolean;
  repoPickerOpen: boolean;
  /** AI settings pop-up on the desktop */
  settingsOpen: boolean;

  showNoise: boolean;
  showExternal: boolean;
  metric: MetricKey;
  confidence: Confidence[];

  /** When not null, the canvas displays a call graph centered on a certain symbol, rather than drilling down the structure. */
  callGraph: CallGraphMode | null;
  openCallGraph: (symbolId: number, label: string) => Promise<void>;
  closeCallGraph: () => void;
  setCallDepth: (depth: number) => Promise<void>;
  setCallDirection: (direction: CallGraphMode["direction"]) => Promise<void>;
  setConfidence: (confidence: Confidence[]) => Promise<void>;

  /** When not null, the main area switches to single-step execution: follow the calls to examine each function body, can step into and step out */
  walk: WalkState | null;
  openWalk: (symbolId: string, label: string) => void;
  setWalkStack: (stack: WalkFrameRef[]) => void;
  closeWalk: () => void;
  /** When walking through the code, also list external libraries and calls that cannot be resolved as steps */
  walkAllCalls: boolean;
  setWalkAllCalls: (value: boolean) => void;
  /** Bypass calls such as timing and logging are also listed as steps; folded by default */
  walkShowTrivial: boolean;
  setWalkShowTrivial: (value: boolean) => void;
  /** Only follow the main path: skip the early return guard branches and catch */
  walkMainPath: boolean;
  setWalkMainPath: (value: boolean) => void;

  boot: () => Promise<void>;
  loadScope: (scopeId: string, limitOverride?: number, keep?: string) => Promise<void>;
  toggleExpand: (node: GraphNodeDto) => Promise<void>;
  collapse: (nodeId: string) => void;
  select: (nodeId: string | null) => void;
  /** Expand to the layer where the target node is and select it. Both the search results and the checklist rely on it to bring the graph over. */
  reveal: (nodeId: string) => Promise<void>;
  /** Click an item in the structure tree: in the structure view, expand to it and center it; in the walkthrough and call graph, only select it, without pulling the person away from the current view */
  locate: (nodeId: string) => void;
  /** The most recent reveal target, for the canvas to move the viewport over; clear after consumption */
  revealed: string | null;
  clearRevealed: () => void;
  /** Locate the node, and have the details open the specified tab (scroll to those lines if there is a line number). Clear after the details are consumed. */
  detailRequest: DetailRequest | null;
  /** When reveal is false, only open the details, the canvas does not move: there is no need to look for files that are not originally displayed on the canvas */
  openDetail: (nodeId: string, request: Omit<DetailRequest, "nodeId">, reveal?: boolean) => void;
  clearDetailRequest: () => void;
  hover: (nodeId: string | null, anchor?: { x: number; y: number }) => void;
  setFocus: (nodeId: string | null, depth?: number) => void;
  hideBranch: (nodeId: string) => void;

  /** For internal use: Re-pull the call graph according to the current mode parameters */
  loadCallGraph: (mode: CallGraphMode) => Promise<void>;

  setDrawerOpen: (open: boolean) => void;
  setChatOpen: (open: boolean) => void;
  panelTab: PanelTab;
  setPanelTab: (tab: PanelTab) => void;
  setTreeOpen: (open: boolean) => void;
  setFilterOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setHelpOpen: (open: boolean) => void;
  setRepoPickerOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;

  setShowNoise: (value: boolean) => void;
  setShowExternal: (value: boolean) => void;
  setMetric: (value: MetricKey) => void;

  /** Layered rollback of Esc, see docs/INTERACTION.md gesture semantic table */
  escape: () => void;

  hiddenNodes: string[];
  resetHidden: () => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  overview: null,
  bootError: null,

  repos: [],
  // Restore from the URL when the module loads to ensure that the first /overview request does not read the boot repository first.
  repoId: getActiveRepo() ?? null,
  noRepo: false,
  addRepoRequest: 0,
  repoRevision: 0,
  indexRevision: 0,
  watchStatus: null,
  lens: savedLens(),

  rootScope: "dir:.",
  subgraphs: {},
  loadingScopes: [],
  scopeLimits: {},
  expanded: [],

  focus: null,
  focusDepth: 1,

  selected: null,
  hovered: null,
  hoverAnchor: null,

  drawerOpen: false,
  chatOpen: readPref(PREF.chatOpen) === "on",
  treeOpen: readPref(PREF.treeOpen) === "on",
  panelTab: savedChoice<PanelTab>(PREF.panelTab, PANEL_TABS, "tree"),
  revealed: null,
  detailRequest: null,
  filterOpen: false,
  paletteOpen: false,
  helpOpen: false,
  repoPickerOpen: false,
  settingsOpen: false,

  showNoise: readPref(PREF.noise) === "on",
  showExternal: readPref(PREF.external) === "on",
  metric: savedChoice<MetricKey>(PREF.metric, ["loc", "complexity", "symbols"], "loc"),
  confidence: savedConfidence(),

  callGraph: null,
  walk: null,
  walkAllCalls: readPref(PREF.walkAllCalls) === "on",
  walkShowTrivial: readPref(PREF.walkTrivial) === "on",
  walkMainPath: readPref(PREF.walkMainPath) === "on",

  hiddenNodes: [],

  async boot() {
    const revision = get().repoRevision;
    // First, retrieve the list to verify the repo in the URL. If invalid, removed, or the index is missing, fall back to
    // Start the service repository to prevent a single expired bookmark from permanently hanging the page on an error.
    try {
      const { current, repos } = await api.repos();
      if (revision !== get().repoRevision) return;
      const requested = get().repoId;
      const selected = requested && repos.some((repo) => repo.id === requested && repo.status === "ok")
        ? requested
        : current ?? repos.find((repo) => repo.status === "ok")?.id ?? null;
      if (selected === null) {
        setActiveRepo(undefined);
        set({ repos, repoId: null, noRepo: true, bootError: null });
        return;
      }
      setActiveRepo(selected);
      set({ repos, repoId: selected, noRepo: false });
    } catch {
      // If the list is unavailable, still attempt the current URL/service default repository, maintaining the original fallback capability.
    }

    try {
      const overview = await api.overview();
      if (revision !== get().repoRevision) return;
      set({ overview, bootError: null });
      await get().loadScope(get().rootScope);
    } catch (err) {
      if (revision === get().repoRevision) set({ bootError: (err as Error).message });
    }
  },

  async switchRepo(id, forceReload = false) {
    // Even if it is already the current repository, you still need to complete the URL; for example, when opening from a parameterless address for the first time.
    setActiveRepo(id);
    if (id === get().repoId && !forceReload) return;
    const repoRevision = get().repoRevision + 1;
    // All view states are lost: the expanded hierarchy, selected items, and hidden items all belong to node IDs from the previous repository.
    // Keeping it will cause the new warehouse's map to have several extra layers of empty shells that can't be unfolded out of nowhere.
    // But preferences (noise, external dependencies, metrics, confidence, panel open/close) follow the person and are not reset.
    set({
      repoId: id,
      repoRevision,
      noRepo: false,
      watchStatus: null,
      overview: null,
      bootError: null,
      subgraphs: {},
      loadingScopes: [],
      scopeLimits: {},
      expanded: [],
      focus: null,
      selected: null,
      hovered: null,
      hoverAnchor: null,
      drawerOpen: false,
      callGraph: null,
      walk: null,
      hiddenNodes: [],
      revealed: null,
      detailRequest: null,
    });
    await get().boot();
  },

  async refreshRepos() {
    const { current, repos } = await api.repos();
    set({ repos, repoId: get().repoId ?? current });
  },

  async refreshIndex(at) {
    if (at !== undefined) {
      if (at === lastIndexAt) return;
      lastIndexAt = at;
    }
    const revision = get().repoRevision;
    const repoId = get().repoId;
    const isCurrentRepo = () => revision === get().repoRevision && repoId === get().repoId;
    set((state) => ({ indexRevision: state.indexRevision + 1 }));
    try {
      const overview = await api.overview();
      if (isCurrentRepo()) set({ overview });
    } catch {
      // If the overview can't be obtained, just keep the old one for now, but the photos should be retaken as usual.
    }
    if (!isCurrentRepo()) return;
    // Re-acquire the already taken scope in place: the expanded levels, selected items, and walkthrough position are all preserved
    const { subgraphs, callGraph } = get();
    await Promise.all(Object.keys(subgraphs).filter((scope) => !scope.startsWith("call:")).map((scope) => get().loadScope(scope)));
    if (callGraph && isCurrentRepo()) await get().loadCallGraph(callGraph);
  },

  setWatchStatus(status) {
    set({ watchStatus: status });
  },

  setLens(lens) {
    writePref(PREF.lens, lens);
    set({ lens });
  },

  requestAddRepo() {
    set((state) => ({ addRepoRequest: state.addRepoRequest + 1 }));
  },

  async refreshOverview() {
    if (get().overview === null) return;
    const revision = get().repoRevision;
    const overview = await api.overview();
    if (revision === get().repoRevision) set({ overview });
  },

  async forgetRepo(id) {
    await api.forgetRepo(id);
    set((state) => ({ repos: state.repos.filter((r) => r.id !== id) }));
  },

  async loadScope(scopeId, limitOverride, keep) {
    const { loadingScopes, showNoise, showExternal, scopeLimits } = get();
    if (loadingScopes.includes(scopeId)) return;
    const revision = get().repoRevision;
    const repoId = get().repoId;

    const limit = limitOverride ?? scopeLimits[scopeId] ?? BASE_LIMIT;
    set({ loadingScopes: [...loadingScopes, scopeId] });

    try {
      const graph = await api.graph({
        scope: scopeId,
        limit,
        roles: (showNoise ? ALL_VISIBLE_ROLES : SOURCE_ONLY_ROLES).join(","),
        external: showExternal && scopeId === get().rootScope,
        keep,
      });
      if (revision !== get().repoRevision || get().repoId !== repoId) return;
      set((state) => ({
        subgraphs: { ...state.subgraphs, [scopeId]: graph },
        scopeLimits: { ...state.scopeLimits, [scopeId]: limit },
      }));
    } catch (err) {
      if (revision !== get().repoRevision || get().repoId !== repoId) return;
      // The failure to load a single scope should not clear the entire graph; treat it as an empty subgraph.
      set((state) => ({
        subgraphs: { ...state.subgraphs, [scopeId]: { nodes: [], edges: [], truncated: 0 } },
        bootError: state.overview === null ? (err as Error).message : state.bootError,
      }));
    } finally {
      if (revision === get().repoRevision && get().repoId === repoId) {
        set((state) => ({ loadingScopes: state.loadingScopes.filter((s) => s !== scopeId) }));
      }
    }
  },

  async openCallGraph(symbolId, label) {
    const scopeId = callScope(symbolId);
    const mode: CallGraphMode = {
      scopeId,
      symbolId,
      label,
      depth: get().callGraph?.depth ?? Number(savedChoice(PREF.callDepth, ["1", "2", "3"], "1")),
      direction: get().callGraph?.direction ??
        savedChoice<CallGraphMode["direction"]>(PREF.callDirection, ["callers", "callees", "both"], "both"),
    };
    // First switch the mode, then fetch the data: otherwise, you have to wait for a round trip of the canvas to get a response, which looks like the click was lost.
    set({ callGraph: mode, walk: null, selected: `sym:${symbolId}`, drawerOpen: false });
    await get().loadCallGraph(mode);
  },

  closeCallGraph() {
    set({ callGraph: null });
  },

  openWalk(symbolId, label) {
    // Keep the sidebars open, and the Reading View will make space according to their width.
    set({
      walk: { label, stack: [{ id: symbolId, name: label, at: null }] },
      callGraph: null,
    });
  },

  setWalkStack(stack) {
    const walk = get().walk;
    if (walk && stack.length > 0) set({ walk: { ...walk, stack } });
  },

  closeWalk() {
    set({ walk: null });
  },

  setWalkAllCalls(value) {
    writePref(PREF.walkAllCalls, value ? "on" : "off");
    set({ walkAllCalls: value });
  },

  setWalkShowTrivial(value) {
    writePref(PREF.walkTrivial, value ? "on" : "off");
    set({ walkShowTrivial: value });
  },

  setWalkMainPath(value) {
    writePref(PREF.walkMainPath, value ? "on" : "off");
    set({ walkMainPath: value });
  },

  async setCallDepth(depth) {
    const current = get().callGraph;
    if (!current) return;
    const next = { ...current, depth };
    writePref(PREF.callDepth, String(depth));
    set({ callGraph: next });
    await get().loadCallGraph(next);
  },

  async setCallDirection(direction) {
    const current = get().callGraph;
    if (!current) return;
    const next = { ...current, direction };
    writePref(PREF.callDirection, direction);
    set({ callGraph: next });
    await get().loadCallGraph(next);
  },

  async setConfidence(confidence) {
    writePref(PREF.confidence, confidence.join(","));
    set({ confidence });
    const current = get().callGraph;
    if (current) await get().loadCallGraph(current);
  },

  async loadCallGraph(mode) {
    const revision = get().repoRevision;
    const repoId = get().repoId;
    try {
      const graph = await api.callGraph(mode.symbolId, {
        depth: mode.depth,
        direction: mode.direction,
        confidence: get().confidence.join(","),
      });
      if (revision !== get().repoRevision || get().repoId !== repoId) return;
      set((state) => ({ subgraphs: { ...state.subgraphs, [mode.scopeId]: graph } }));
    } catch {
      if (revision !== get().repoRevision || get().repoId !== repoId) return;
      set((state) => ({
        subgraphs: { ...state.subgraphs, [mode.scopeId]: { nodes: [], edges: [], truncated: 0 } },
      }));
    }
  },

  async toggleExpand(node) {
    const { expanded } = get();

    if (expanded.includes(node.id)) {
      get().collapse(node.id);
      return;
    }

    if (!node.expandable) return;

    // The aggregation node does not have an independent subgraph; its 'expansion' is equivalent to raising the upper limit of the parent scope and re-evaluating.
    if (node.kind === "aggregate") {
      const parentScope = node.id.slice("agg:".length);
      const current = get().scopeLimits[parentScope] ?? BASE_LIMIT;
      await get().loadScope(parentScope, current + node.childCount + 1);
      return;
    }

    set({ expanded: [...expanded, node.id] });
    if (!get().subgraphs[node.id]) await get().loadScope(node.id);
  },

  async reveal(nodeId) {
    const revision = get().repoRevision;
    const repoId = get().repoId;
    const isCurrentRepo = () => revision === get().repoRevision && repoId === get().repoId;
    // The coordinate system is completely different in call graph mode, first go back to the structure view before navigating
    if (get().callGraph !== null || get().walk !== null) {
      set({ callGraph: null, walk: null });
    }

    try {
      const { chain } = await api.revealChain(nodeId);
      if (!isCurrentRepo()) return;
      // It must be unfolded sequentially: the subgraph of each layer can only know which scope to request after the parent layer has finished loading.
      // Keep is applied at every layer because the target's ancestors might also be folded into aggregation nodes due to their small size.
      for (const [i, scope] of chain.entries()) {
        if (!get().expanded.includes(scope)) {
          set({ expanded: [...get().expanded, scope] });
        }
        const next = chain[i + 1] ?? nodeId;
        await get().loadScope(scope, get().scopeLimits[scope], next);
        if (!isCurrentRepo()) return;
      }
      // The root scope also needs to be locked once: in repositories with many packages/top-level directories, it is the package where the target is located
      // It may be collapsed in the root view itself
      const root = get().rootScope;
      await get().loadScope(root, get().scopeLimits[root], chain[0] ?? nodeId);
      if (!isCurrentRepo()) return;
      set({ revealed: nodeId });
    } catch {
      // If you can't get the chain, it will degrade to just selecting, at least the detail drawer can still be viewed.
    }

    if (isCurrentRepo()) get().select(nodeId);
  },

  locate(nodeId) {
    if (get().walk !== null || get().callGraph !== null) get().select(nodeId);
    else void get().reveal(nodeId);
  },

  collapse(nodeId) {
    set((state) => ({
      // When collapsing a node, all of its expanded descendants inside it should also be collapsed.
      // Otherwise, expanding it again will suddenly release a bunch of levels left from last time.
      expanded: state.expanded.filter((id) => id !== nodeId && !isDescendantScope(state, id, nodeId)),
    }));
  },

  select(nodeId) {
    set({ selected: nodeId, drawerOpen: nodeId !== null });
  },

  hover(nodeId, anchor) {
    set({ hovered: nodeId, hoverAnchor: anchor ?? null });
  },

  setFocus(nodeId, depth) {
    set({ focus: nodeId, focusDepth: depth ?? get().focusDepth });
  },

  hideBranch(nodeId) {
    set((state) => ({ hiddenNodes: [...new Set([...state.hiddenNodes, nodeId])] }));
  },

  resetHidden() {
    set({ hiddenNodes: [] });
  },

  clearRevealed() {
    set({ revealed: null });
  },

  openDetail(nodeId, request, reveal = true) {
    set({ detailRequest: { nodeId, ...request } });
    if (reveal) void get().reveal(nodeId);
    else get().select(nodeId);
  },

  clearDetailRequest() {
    set({ detailRequest: null });
  },

  setPanelTab(tab) {
    set({ panelTab: tab });
  },

  setDrawerOpen(open) {
    set({ drawerOpen: open });
  },
  setChatOpen(open) {
    set({ chatOpen: open });
  },
  setTreeOpen(open) {
    set({ treeOpen: open });
  },
  setFilterOpen(open) {
    set({ filterOpen: open });
  },
  setPaletteOpen(open) {
    set({ paletteOpen: open });
  },
  setHelpOpen(open) {
    set({ helpOpen: open });
  },
  setRepoPickerOpen(open) {
    set({ repoPickerOpen: open });
  },
  setSettingsOpen(open) {
    set({ settingsOpen: open });
  },

  setShowNoise(value) {
    writePref(PREF.noise, value ? "on" : "off");
    set({ showNoise: value, subgraphs: {}, scopeLimits: {} });
    void get().loadScope(get().rootScope);
    for (const id of get().expanded) void get().loadScope(id);
  },

  setShowExternal(value) {
    writePref(PREF.external, value ? "on" : "off");
    set({ showExternal: value, subgraphs: {}, scopeLimits: {} });
    void get().loadScope(get().rootScope);
    for (const id of get().expanded) void get().loadScope(id);
  },

  setMetric(value) {
    writePref(PREF.metric, value);
    set({ metric: value });
  },

  escape() {
    const state = get();
    if (state.settingsOpen) return set({ settingsOpen: false });
    if (state.paletteOpen) return set({ paletteOpen: false });
    if (state.helpOpen) return set({ helpOpen: false });
    if (state.repoPickerOpen) return set({ repoPickerOpen: false });
    if (state.filterOpen) return set({ filterOpen: false });
    // The conversation overlaps on the details, collapse it first; the chat history is retained, and it will still be there when reopened.
    if (state.chatOpen) return set({ chatOpen: false });
    if (state.drawerOpen) return set({ drawerOpen: false });
    if (state.walk !== null) return set({ walk: null });
    if (state.selected !== null) return set({ selected: null });
    if (state.focus !== null) return set({ focus: null });
    // Exit the call graph before it is expanded: it's a 'swapped chart', which is outer than collapsing the hierarchy
    if (state.callGraph !== null) return set({ callGraph: null });
    if (state.hiddenNodes.length > 0) return set({ hiddenNodes: [] });
    if (state.expanded.length > 0) return set({ expanded: [] });
    if (state.treeOpen) return set({ treeOpen: false });
    return undefined;
  },
}));

// There are many ways to open and close the sidebar (top bar button, × on the panel, Esc, ⌘I). We'll record them all here so we don't have to write each method separately.
useAppStore.subscribe((state, prev) => {
  if (state.treeOpen !== prev.treeOpen) writePref(PREF.treeOpen, state.treeOpen ? "on" : "off");
  if (state.panelTab !== prev.panelTab) writePref(PREF.panelTab, state.panelTab);
  if (state.chatOpen !== prev.chatOpen) writePref(PREF.chatOpen, state.chatOpen ? "on" : "off");
});

/**
 * Only subscribe to the four fields that determine the diagram structure.
 *
 * Using useShallow is necessary: the selector returns a new object, and without shallow comparison every time
 * Any change in the store will be considered as 'changed,' so narrowing the subscription would be pointless.
 */
export function useGraphSlice(): GraphSlice {
  return useAppStore(
    useShallow((s) => ({
      // The call graph is flat; treat it as a scope without expanded items and hand it over to the same puzzle logic.
      // Canvas, layout, and hover highlighting all do not need branches added for it.
      rootScope: s.callGraph?.scopeId ?? s.rootScope,
      subgraphs: s.subgraphs,
      expanded: s.callGraph ? EMPTY : s.expanded,
      hiddenNodes: s.hiddenNodes,
    })),
  );
}

/** Stable empty array reference, avoiding the creation of a new object on each selector evaluation that would break shallow comparison */
const EMPTY: string[] = [];

/** Determine whether the expanded node 'candidate' falls within the subtree of 'ancestor' */
function isDescendantScope(state: AppState, candidate: string, ancestor: string): boolean {
  const graph = state.subgraphs[ancestor];
  if (!graph) return false;
  if (graph.nodes.some((n) => n.id === candidate)) return true;
  return graph.nodes.some((n) => isDescendantScope(state, candidate, n.id));
}
