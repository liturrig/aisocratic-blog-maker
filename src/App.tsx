import { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  pointerWithin,
  rectIntersection,
  type DragEndEvent,
  type DragStartEvent,
  type DragOverEvent,
  type CollisionDetection,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  RotateCcw,
  Newspaper,
  Plus,
  Maximize2,
  Minimize2,
  X,
  Pencil,
  Save as SaveIcon,
  History,
  Check,
  LogOut,
  FileJson,
} from "lucide-react";
import { MacroGroup } from "./components/MacroGroup";
import { NewsEditor } from "./components/NewsEditor";
import { LoginPage } from "./components/LoginPage";
import { WelcomePage } from "./components/WelcomePage";
import { BrandLogo } from "./components/BrandLogo";
import {
  buildPreviewHTML,
  fetchHTML,
  newItem,
  newMacro,
  parseBlog,
  PROXIES,
  PROXY_LABELS,
  type BlogModel,
  type MacroSection,
  type NewsItem,
} from "./lib/parser";
import {
  canonicalizeSourceUrl,
  cloneProjectDocument,
  formatRelative,
  normalizeUserId,
  newProjectId,
  projectRepository,
  sourceCacheRepository,
  type ProjectChangeOperation,
  type ProjectDocument,
  type ProjectSnapshot,
  type ProjectSyncState,
} from "./lib/storage";

const AUTH_KEY = "aisocratic:auth";
const LEGACY_AUTH_KEY = "aperitivo:auth";

function cloneBlogModel(model: BlogModel): BlogModel {
  if (typeof structuredClone === "function") return structuredClone(model);
  return JSON.parse(JSON.stringify(model)) as BlogModel;
}

function currentTimestamp(): number {
  // Wrapped so event handlers and async helpers can read "now" without tripping the
  // React purity lint that flags direct Date.now() calls inside component scope.
  return Date.now();
}

function readStoredAuthUser(): string | null {
  try {
    const current = localStorage.getItem(AUTH_KEY);
    if (current) return current;

    const legacy = localStorage.getItem(LEGACY_AUTH_KEY);
    if (!legacy) return null;

    localStorage.setItem(AUTH_KEY, legacy);
    localStorage.removeItem(LEGACY_AUTH_KEY);
    return legacy;
  } catch {
    return null;
  }
}

export default function App() {
  const [authUser, setAuthUser] = useState<string | null>(() => readStoredAuthUser());
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [url, setUrl] = useState("https://aisocratic.org/blog/ai-socratic-may-2026");
  const [proxy, setProxy] = useState(PROXIES[0]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [model, setModel] = useState<BlogModel | null>(null);
  const [initialMacroOrder, setInitialMacroOrder] = useState<string>("");
  const [previewURL, setPreviewURL] = useState<string>("");
  const [fullscreen, setFullscreen] = useState(false);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const [previewEditMode, setPreviewEditMode] = useState(false);
  const [editing, setEditing] = useState<
    | { kind: "item"; macroId: string; itemId: string }
    | { kind: "macro"; macroId: string }
    | null
  >(null);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [savedProjects, setSavedProjects] = useState<ProjectDocument[]>([]);
  const [currentSyncState, setCurrentSyncState] = useState<ProjectSyncState | null>(null);
  const editModeSnapshotRef = useRef<BlogModel | null>(null);
  const lastOverContainerRef = useRef<string | null>(null);
  const skipNextPreviewRebuild = useRef(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const macroIds = useMemo(() => model?.macros.map((m) => m.id) ?? [], [model]);

  const orderSignature = useMemo(
    () =>
      model
        ? model.macros.map((m) => m.id + ":" + m.items.map((i) => i.id).join(",")).join("|")
        : "",
    [model]
  );
  const hasChanges = orderSignature !== initialMacroOrder && model !== null;

  function buildProjectDocument(savedAt: number): ProjectDocument | null {
    if (!model || !currentProjectId) return null;
    const existing = savedProjects.find((p) => p.id === currentProjectId);
    return {
      id: currentProjectId,
      sourceUrl: canonicalizeSourceUrl(model.baseHref),
      title: model.header?.title || model.baseHref,
      createdAt: existing?.createdAt ?? savedAt,
      savedAt,
      model,
    };
  }

  function buildProjectSnapshot(savedAt: number): ProjectSnapshot | null {
    const project = buildProjectDocument(savedAt);
    if (!project) return null;
    return {
      project,
      syncState: ensureSyncState(project, currentSyncState),
    };
  }

  function createSeedProject(project: ProjectDocument): ProjectDocument {
    return cloneProjectDocument(project);
  }

  function ensureSyncState(project: ProjectDocument, syncState?: ProjectSyncState | null): ProjectSyncState {
    return {
      remoteId: null,
      revision: null,
      lastSyncedAt: null,
      seedProject: syncState?.seedProject ? cloneProjectDocument(syncState.seedProject) : createSeedProject(project),
      pendingOperations: [],
    };
  }

  function enqueueOperations(operations: ProjectChangeOperation[], seedProject?: ProjectDocument | null) {
    void operations;
    void seedProject;
  }

  async function hydrateProjectOriginalHTML(project: ProjectDocument): Promise<ProjectDocument> {
    if (project.model.originalHTML) return project;
    if (model && model.baseHref === project.model.baseHref && model.originalHTML) {
      return {
        ...project,
        model: { ...project.model, originalHTML: model.originalHTML },
      };
    }
    const cached = await sourceCacheRepository.loadCachedSource(project.sourceUrl);
    if (cached?.html) {
      return {
        ...project,
        model: { ...project.model, originalHTML: cached.html },
      };
    }
    return project;
  }

  async function refreshSavedProjects(userId = authUser) {
    if (!userId) {
      setSavedProjects([]);
      return;
    }
    setSavedProjects(await projectRepository.listProjects(userId));
  }

  async function resolveSourceModel(rawUrl: string): Promise<{ sourceUrl: string; model: BlogModel }> {
    const sourceUrl = canonicalizeSourceUrl(rawUrl);
    const cached = await sourceCacheRepository.loadCachedSource(sourceUrl);
    if (cached?.model) {
      return { sourceUrl, model: cloneBlogModel(cached.model) };
    }

    const html = await fetchHTML(sourceUrl, proxy);
    const parsed = parseBlog(html, sourceUrl);
    await sourceCacheRepository.saveCachedSource({
      sourceUrl,
      html,
      model: parsed,
      fetchedAt: currentTimestamp(),
    });
    return { sourceUrl, model: cloneBlogModel(parsed) };
  }

  useEffect(() => {
    let cancelled = false;
    if (!authUser) return;

    void (async () => {
      const projects = await projectRepository.listProjects(authUser);
      if (!cancelled) setSavedProjects(projects);
    })();

    return () => {
      cancelled = true;
    };
  }, [authUser]);

  useEffect(() => {
    if (!model) return;
    if (skipNextPreviewRebuild.current) {
      skipNextPreviewRebuild.current = false;
      return;
    }
    const html = buildPreviewHTML(model, { editMode: previewEditMode });
    const blob = new Blob([html], { type: "text/html" });
    const u = URL.createObjectURL(blob);
    setPreviewURL((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return u;
    });
    return () => URL.revokeObjectURL(u);
  }, [model, previewEditMode]);

  // Receive edits from the preview iframe (postMessage from edit-mode script)
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const data = e.data;
      if (!data || typeof data.type !== "string") return;
      const editorTypes = ["post-title", "macro-title", "macro-intro", "item-title", "item-edit"];
      if (editorTypes.includes(data.type)) {
        // The iframe already reflects the change; don't rebuild it & steal focus.
        skipNextPreviewRebuild.current = true;
      }
      setModel((m) => {
        if (!m) return m;
        const next = cloneModel(m);

        if (data.type === "post-title" && typeof data.text === "string") {
          next.header.title = data.text;
          return next;
        }
        if (data.type === "macro-title" && typeof data.id === "string" && typeof data.text === "string") {
          const macro = next.macros.find((x) => x.id === data.id);
          if (macro) {
            macro.title = data.text;
            macro.headingHTML = `<h1 id="${macro.id}" class="macro-heading">${escapeHTML(data.text)}</h1>`;
          }
          return next;
        }
        if (data.type === "macro-intro" && typeof data.id === "string" && typeof data.html === "string") {
          const macro = next.macros.find((x) => x.id === data.id);
          if (macro) macro.introHTML = data.html;
          return next;
        }
        if (data.type === "item-title" && typeof data.id === "string" && typeof data.text === "string") {
          for (const macro of next.macros) {
            const item = macro.items.find((i) => i.id === data.id);
            if (item) {
              item.title = data.text;
              item.headingHTML = `<h${item.level} id="${item.id}" class="news-heading">${escapeHTML(
                data.text
              )}</h${item.level}>`;
              break;
            }
          }
          return next;
        }
        if (data.type === "item-edit" && typeof data.id === "string") {
          for (const macro of next.macros) {
            const item = macro.items.find((i) => i.id === data.id);
            if (item) {
              item.bodyHTML = String(data.html);
              const tmp = document.createElement("div");
              tmp.innerHTML = item.bodyHTML;
              item.snippet = (tmp.textContent || "").replace(/\s+/g, " ").trim().slice(0, 220);
              const firstImg = tmp.querySelector("img");
              item.imageUrl = firstImg?.getAttribute("src") || undefined;
              break;
            }
          }
          return next;
        }
        return m;
      });
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Auto-save model to IndexedDB (debounced).
  // Paused while previewEditMode is on so intermediate inline edits aren't persisted
  // until the user confirms or discards them.
  useEffect(() => {
    if (!model || !currentProjectId || !authUser) return;
    if (previewEditMode) return;
    const t = setTimeout(() => {
      const now = currentTimestamp();
      const project = buildProjectDocument(now);
      if (!project) {
        setError("Unable to save the current project.");
        return;
      }
      void (async () => {
        const snapshot = buildProjectSnapshot(now);
        if (!snapshot) {
          setError("Unable to save the current project.");
          return;
        }
        if (await projectRepository.saveProjectSnapshot(authUser, snapshot)) {
          setLastSavedAt(snapshot.project.savedAt);
          await refreshSavedProjects(authUser);
        }
      })();
    }, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, currentProjectId, previewEditMode, authUser]);

  // Brief "Salvato!" confirmation flash on the Salva button
  useEffect(() => {
    if (!justSaved) return;
    const t = setTimeout(() => setJustSaved(false), 1600);
    return () => clearTimeout(t);
  }, [justSaved]);

  // ESC closes fullscreen and mobile actions
  useEffect(() => {
    if (!fullscreen && !mobileActionsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setFullscreen(false);
      setMobileActionsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen, mobileActionsOpen]);

  /** Fetch a URL fresh and start a NEW project (independent id, even if URL is reused). */
  async function startNewProject(rawUrl: string) {
    if (!authUser) return;
    setError(null);
    setLoading(true);
    setModel(null);
    setPreviewURL("");
    try {
      const { sourceUrl, model: parsed } = await resolveSourceModel(rawUrl);
      const id = newProjectId();
      const now = currentTimestamp();
      const project: ProjectDocument = {
        id,
        sourceUrl,
        title: parsed.header?.title || sourceUrl,
        createdAt: now,
        savedAt: now,
        model: parsed,
      };
      const syncState = ensureSyncState(project, null);
      await projectRepository.saveProjectSnapshot(authUser, { project, syncState });
      setCurrentProjectId(id);
      setCurrentSyncState(syncState);
      setLastSavedAt(now);
      adoptModel(parsed);
      await refreshSavedProjects(authUser);
      setUrl(sourceUrl);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg + " — try changing the CORS proxy.");
    } finally {
      setLoading(false);
    }
  }

  function adoptModel(m: BlogModel) {
    setModel(m);
    setInitialMacroOrder(
      m.macros.map((mc) => mc.id + ":" + mc.items.map((i) => i.id).join(",")).join("|")
    );
  }

  async function resumeProject(project: ProjectDocument) {
    if (!authUser) return;
    const snapshot = await projectRepository.loadProjectSnapshot(authUser, project.id);
    if (!snapshot) {
      setError("Unable to load the selected saved project.");
      return;
    }
    const hydratedProject = await hydrateProjectOriginalHTML(snapshot.project);
    setCurrentProjectId(hydratedProject.id);
    setUrl(hydratedProject.sourceUrl);
    setCurrentSyncState(ensureSyncState(hydratedProject, snapshot.syncState));
    setLastSavedAt(hydratedProject.savedAt);
    adoptModel(cloneBlogModel(hydratedProject.model));
  }

  async function removeSavedProject(p: ProjectDocument) {
    if (!window.confirm(`Delete the saved project "${p.title}"?`)) return;
    if (!authUser) return;
    await projectRepository.deleteProject(authUser, p.id);
    await refreshSavedProjects();
    if (currentProjectId === p.id) {
      // We just deleted the open project; go back to the dashboard
      setCurrentProjectId(null);
      setCurrentSyncState(null);
      setLastSavedAt(null);
      setModel(null);
      setPreviewURL("");
    }
  }

  async function reloadFromOriginal() {
    if (!model || !currentProjectId) return;
    if (!window.confirm("Discard all changes to this project and reload the original version?")) return;
    const project = buildProjectDocument(currentTimestamp());
    if (!project) return;
    const seedProject = currentSyncState?.seedProject ?? project;
    const resetProject = cloneProjectDocument(seedProject);
    enqueueOperations([{ type: "reset-project" }], seedProject);
    adoptModel(cloneBlogModel(resetProject.model));
    setUrl(resetProject.sourceUrl);
    setEditing(null);
  }

  async function saveNow() {
    if (!model || !currentProjectId || !authUser) return;
    const now = currentTimestamp();
    const snapshot = buildProjectSnapshot(now);
    if (snapshot && (await projectRepository.saveProjectSnapshot(authUser, snapshot))) {
      setLastSavedAt(snapshot.project.savedAt);
      await refreshSavedProjects(authUser);
      setJustSaved(true);
    }
  }

  function handleLogin(username: string) {
    const normalized = normalizeUserId(username);
    try {
      localStorage.setItem(AUTH_KEY, normalized);
      localStorage.removeItem(LEGACY_AUTH_KEY);
    } catch {
      /* noop */
    }
    setAuthUser(normalized);
  }

  function handleLogout() {
    try {
      localStorage.removeItem(AUTH_KEY);
      localStorage.removeItem(LEGACY_AUTH_KEY);
    } catch {
      /* noop */
    }
    setAuthUser(null);
    setSavedProjects([]);
    setCurrentSyncState(null);
    setLastSavedAt(null);
    setModel(null);
    setPreviewURL("");
    setCurrentProjectId(null);
  }

  function exportCurrent() {
    if (!model || !currentProjectId || !authUser) return;
    const existingSavedAt = savedProjects.find((p) => p.id === currentProjectId)?.savedAt ?? currentTimestamp();
    const project = buildProjectDocument(existingSavedAt);
    if (!project) return;
    const snapshot: ProjectSnapshot = { project, syncState: currentSyncState };
    projectRepository.exportProjectToFile(snapshot);
  }

  async function importFromFile(file: File) {
    if (!authUser) return;
    try {
      const snapshot = await projectRepository.importProjectFromFile(file, authUser);
      const project = await hydrateProjectOriginalHTML(snapshot.project);
      await refreshSavedProjects(authUser);
      // Open the imported project immediately
      setCurrentProjectId(project.id);
      setUrl(project.sourceUrl);
      setCurrentSyncState(ensureSyncState(project, snapshot.syncState));
      setLastSavedAt(project.savedAt);
      adoptModel(cloneBlogModel(project.model));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError("Import fallito: " + msg);
    }
  }

  function backToWelcome() {
    setMobileActionsOpen(false);
    setCurrentSyncState(null);
    setLastSavedAt(null);
    setModel(null);
    setPreviewURL("");
    setCurrentProjectId(null);
    void refreshSavedProjects();
  }

  function enterPreviewEdit() {
    if (!model) return;
    // Snapshot the current model so user can discard edits later
    editModeSnapshotRef.current = JSON.parse(JSON.stringify(model)) as BlogModel;
    setPreviewEditMode(true);
  }
  function commitPreviewEdit() {
    const before = editModeSnapshotRef.current;
    const currentProject = buildProjectDocument(currentTimestamp());
    if (before && model) {
      enqueueOperations(diffPreviewEdits(before, model), currentProject);
    }
    editModeSnapshotRef.current = null;
    setPreviewEditMode(false);
  }
  function discardPreviewEdit() {
    if (editModeSnapshotRef.current) {
      setModel(editModeSnapshotRef.current);
    }
    editModeSnapshotRef.current = null;
    setPreviewEditMode(false);
  }

  // ─── DnD helpers ──────────────────────────────────────────────────────────
  function findContainer(activeOrOverId: string): string | null {
    if (!model) return null;
    // Macro container itself
    if (model.macros.some((m) => m.id === activeOrOverId)) return activeOrOverId;
    // Droppable area key "drop-<macroId>"
    if (activeOrOverId.startsWith("drop-")) return activeOrOverId.slice(5);
    // Item id → find which macro contains it
    for (const m of model.macros) {
      if (m.items.some((i) => i.id === activeOrOverId)) return m.id;
    }
    return null;
  }

  // Custom collision: prefer item collisions, fall back to droppable container areas
  const collisionDetection: CollisionDetection = (args) => {
    const pointer = pointerWithin(args);
    if (pointer.length) return pointer;
    const intersections = rectIntersection(args);
    if (intersections.length) return intersections;
    return closestCenter(args);
  };

  function handleDragStart(_event: DragStartEvent) {
    void _event;
    lastOverContainerRef.current = null;
  }

  function handleDragOver(e: DragOverEvent) {
    const { active, over } = e;
    if (!over || !model) return;
    const activeData = active.data.current as { type?: string; macroId?: string } | undefined;
    if (activeData?.type !== "item") return;

    const overId = String(over.id);
    const activeId = String(active.id);
    const fromContainer = activeData.macroId;
    const toContainer = findContainer(overId);
    if (!fromContainer || !toContainer || fromContainer === toContainer) return;

    // Move the item to the target container in real-time
    setModel((m) => {
      if (!m) return m;
      const next = cloneModel(m);
      const srcMacro = next.macros.find((x) => x.id === fromContainer)!;
      const dstMacro = next.macros.find((x) => x.id === toContainer)!;
      const idx = srcMacro.items.findIndex((i) => i.id === activeId);
      if (idx < 0) return m;
      const [moved] = srcMacro.items.splice(idx, 1);

      // Insert position in dst
      const overIsItem = dstMacro.items.some((i) => i.id === overId);
      const insertAt = overIsItem
        ? dstMacro.items.findIndex((i) => i.id === overId)
        : dstMacro.items.length;
      dstMacro.items.splice(insertAt, 0, moved);
      // Track active container so we can update active.data.current.macroId — dnd-kit will read fresh data on next event
      return next;
    });
    // Patch active.data so subsequent events know new container
    if (activeData) activeData.macroId = toContainer;
  }

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || !model) return;
    const activeData = active.data.current as { type?: string; macroId?: string } | undefined;
    const activeId = String(active.id);
    const overId = String(over.id);

    if (activeData?.type === "macro") {
      // Reorder macros at the top level
      const oldIndex = model.macros.findIndex((m) => m.id === activeId);
      const newIndex = model.macros.findIndex((m) => m.id === overId);
      if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return;
      const reordered = arrayMove(model.macros, oldIndex, newIndex);
      setModel((m) => (m ? { ...m, macros: reordered } : m));
      enqueueOperations(
        [{ type: "reorder-macros", macroIds: reordered.map((macro) => macro.id) }],
        buildProjectDocument(currentTimestamp())
      );
      return;
    }

    if (activeData?.type === "item") {
      const container = findContainer(overId) || activeData.macroId;
      if (!container) return;
      const macro = model.macros.find((entry) => entry.id === container);
      if (!macro) return;
      const items = macro.items;
      const from = items.findIndex((item) => item.id === activeId);
      if (from < 0) return;
      const overIsItem = items.some((item) => item.id === overId);
      const to = overIsItem ? items.findIndex((item) => item.id === overId) : items.length - 1;
      setModel((m) => {
        if (!m) return m;
        const next = cloneModel(m);
        const macro = next.macros.find((x) => x.id === container)!;
        const items = macro.items;
        const from = items.findIndex((i) => i.id === activeId);
        if (from < 0) return m;
        const overIsItem = items.some((i) => i.id === overId);
        const to = overIsItem ? items.findIndex((i) => i.id === overId) : items.length - 1;
        macro.items = arrayMove(items, from, to);
        return next;
      });
      enqueueOperations(
        [{ type: "move-item", itemId: activeId, toMacroId: container, toIndex: to }],
        buildProjectDocument(currentTimestamp())
      );
    }
  }

  // ─── Mutations ────────────────────────────────────────────────────────────
  function deleteItem(macroId: string, itemId: string) {
    const seedProject = buildProjectDocument(currentTimestamp());
    setModel((m) => {
      if (!m) return m;
      const next = cloneModel(m);
      const macro = next.macros.find((x) => x.id === macroId);
      if (!macro) return m;
      macro.items = macro.items.filter((i) => i.id !== itemId);
      return next;
    });
    enqueueOperations([{ type: "delete-item", macroId, itemId }], seedProject);
  }
  function renameItem(macroId: string, itemId: string) {
    setEditing({ kind: "item", macroId, itemId });
  }
  function editMacro(macroId: string) {
    setEditing({ kind: "macro", macroId });
  }

  function applyEdit(updates: { title: string; bodyHTML: string }) {
    if (!editing) return;
    const seedProject = buildProjectDocument(currentTimestamp());
    const operations: ProjectChangeOperation[] = [];
    setModel((m) => {
      if (!m) return m;
      const next = cloneModel(m);
      if (editing.kind === "item") {
        const macroN = next.macros.find((x) => x.id === editing.macroId);
        const itemN = macroN?.items.find((i) => i.id === editing.itemId);
        if (!itemN) return m;
        itemN.title = updates.title;
        itemN.headingHTML = `<h${itemN.level} id="${itemN.id}" class="news-heading">${escapeHTML(
          updates.title
        )}</h${itemN.level}>`;
        itemN.bodyHTML = updates.bodyHTML;
        const tmp = document.createElement("div");
        tmp.innerHTML = updates.bodyHTML;
        itemN.snippet = (tmp.textContent || "").replace(/\s+/g, " ").trim().slice(0, 220);
        const firstImg = tmp.querySelector("img");
        itemN.imageUrl = firstImg?.getAttribute("src") || undefined;
        operations.push({
          type: "update-item",
          itemId: itemN.id,
          title: updates.title,
          bodyHTML: updates.bodyHTML,
        });
      } else {
        const macroN = next.macros.find((x) => x.id === editing.macroId);
        if (!macroN) return m;
        macroN.title = updates.title;
        macroN.headingHTML = `<h1 id="${macroN.id}" class="macro-heading">${escapeHTML(
          updates.title
        )}</h1>`;
        macroN.introHTML = updates.bodyHTML;
        operations.push({
          type: "update-macro",
          macroId: macroN.id,
          title: updates.title,
          introHTML: updates.bodyHTML,
        });
      }
      return next;
    });
    enqueueOperations(operations, seedProject);
    setEditing(null);
  }

  // Build a NewsItem-shaped target for the editor that works for both items and macros
  const editingTarget = useMemo(() => {
    if (!editing || !model) return null;
    if (editing.kind === "item") {
      const macro = model.macros.find((x) => x.id === editing.macroId);
      const item = macro?.items.find((i) => i.id === editing.itemId);
      if (!item) return null;
      return { item, kind: "News" as const };
    }
    const macro = model.macros.find((x) => x.id === editing.macroId);
    if (!macro) return null;
    const adapted = {
      id: macro.id,
      title: macro.title,
      level: 2 as const,
      headingHTML: macro.headingHTML,
      bodyHTML: macro.introHTML,
      snippet: "",
    };
    return { item: adapted, kind: "Section" as const };
  }, [editing, model]);
  function addItem(macroId: string) {
    const it = newItem("New story");
    const seedProject = buildProjectDocument(currentTimestamp());
    const currentMacro = model?.macros.find((entry) => entry.id === macroId);
    const index = currentMacro?.items.length ?? 0;
    setModel((m) => {
      if (!m) return m;
      const next = cloneModel(m);
      const macro = next.macros.find((x) => x.id === macroId)!;
      macro.items.push(it);
      return next;
    });
    enqueueOperations([{ type: "add-item", macroId, item: it, index }], seedProject);
    // Open the editor immediately so user can add title, body, image, sources
    setEditing({ kind: "item", macroId, itemId: it.id });
  }
  function deleteMacro(macroId: string) {
    if (!window.confirm("Delete the entire section?")) return;
    const seedProject = buildProjectDocument(currentTimestamp());
    setModel((m) => {
      if (!m) return m;
      return { ...m, macros: m.macros.filter((x) => x.id !== macroId) };
    });
    enqueueOperations([{ type: "delete-macro", macroId }], seedProject);
  }
  function addMacro() {
    const mac = newMacro("New section");
    const seedProject = buildProjectDocument(currentTimestamp());
    const index = model?.macros.length ?? 0;
    setModel((m) => (m ? { ...m, macros: [...m.macros, mac] } : m));
    enqueueOperations([{ type: "add-macro", macro: mac, index }], seedProject);
    setEditing({ kind: "macro", macroId: mac.id });
  }
  function resetOrder() {
    reloadFromOriginal();
  }

  function diffPreviewEdits(before: BlogModel, after: BlogModel): ProjectChangeOperation[] {
    const operations: ProjectChangeOperation[] = [];
    if (before.header.title !== after.header.title) {
      operations.push({ type: "set-post-title", title: after.header.title });
    }
    for (const afterMacro of after.macros) {
      const beforeMacro = before.macros.find((macro) => macro.id === afterMacro.id);
      if (!beforeMacro) continue;
      if (beforeMacro.title !== afterMacro.title || beforeMacro.introHTML !== afterMacro.introHTML) {
        operations.push({
          type: "update-macro",
          macroId: afterMacro.id,
          ...(beforeMacro.title !== afterMacro.title ? { title: afterMacro.title } : {}),
          ...(beforeMacro.introHTML !== afterMacro.introHTML ? { introHTML: afterMacro.introHTML } : {}),
        });
      }
      for (const afterItem of afterMacro.items) {
        const beforeItem = beforeMacro.items.find((item) => item.id === afterItem.id);
        if (!beforeItem) continue;
        if (beforeItem.title !== afterItem.title || beforeItem.bodyHTML !== afterItem.bodyHTML) {
          operations.push({
            type: "update-item",
            itemId: afterItem.id,
            ...(beforeItem.title !== afterItem.title ? { title: afterItem.title } : {}),
            ...(beforeItem.bodyHTML !== afterItem.bodyHTML ? { bodyHTML: afterItem.bodyHTML } : {}),
          });
        }
      }
    }
    return operations;
  }

  // ─── Login & Welcome routing ─────────────────────────────────────────────
  if (!authUser) {
    return <LoginPage onLogin={handleLogin} />;
  }
  if (!model) {
    return (
      <WelcomePage
        username={authUser}
        savedProjects={savedProjects}
        loading={loading}
        initialURL={url}
        onLoadURL={(u) => startNewProject(u)}
        onResume={(p) => {
          void resumeProject(p);
        }}
        onDelete={(p) => removeSavedProject(p)}
        onImport={(f) => importFromFile(f)}
        onLogout={handleLogout}
      />
    );
  }

  return (
    <div className="h-full flex flex-col bg-ink-900 text-ink-100">
      <header className="px-4 sm:px-6 py-3 border-b border-ink-600 bg-gradient-to-b from-ink-800 to-ink-900 flex flex-wrap items-center gap-3 sticky top-0 z-20">
        <button
          onClick={backToWelcome}
          className="flex items-center font-semibold hover:opacity-80 transition"
          title="Back to dashboard"
        >
          <BrandLogo className="h-9 w-auto" />
        </button>

        <div className="order-3 w-full min-w-0 lg:order-none lg:w-auto lg:flex-1 flex items-center gap-2">
          <span className="text-xs text-ink-300 truncate">
            <span className="text-ink-100 font-medium">{model.header?.title || "(untitled)"}</span>
            <span className="opacity-60 mx-2">·</span>
            <code className="text-brand-400 truncate">{model.baseHref}</code>
          </span>
        </div>

        <div className="ml-auto flex items-center gap-2 lg:hidden">
          <button
            onClick={() => setFullscreen(true)}
            disabled={!previewURL}
            className="w-10 h-10 rounded-lg border border-ink-600 hover:border-brand text-ink-300 hover:text-brand-400 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition"
            title="Open fullscreen preview"
            aria-label="Open fullscreen preview"
          >
            <Maximize2 size={16} />
          </button>
          <button
            onClick={() => setMobileActionsOpen(true)}
            className="w-10 h-10 rounded-lg border border-ink-600 hover:border-brand text-ink-300 hover:text-brand-400 flex items-center justify-center text-lg leading-none transition"
            title="Open project actions"
            aria-label="Open project actions"
          >
            ⋯
          </button>
        </div>

        <div className="hidden lg:flex items-center gap-2">
          <button
            onClick={backToWelcome}
            className="px-3 py-2 rounded-lg border border-ink-600 hover:border-brand
                       text-sm flex items-center gap-2 transition"
            title="Back to dashboard"
          >
            <History size={13} /> Projects
          </button>
          {lastSavedAt && model && (
            <span
              className="text-[11px] text-ink-300 flex items-center gap-1.5 mr-1"
              title={`Saved automatically in the browser · ${new Date(lastSavedAt).toLocaleString()}`}
            >
              <SaveIcon size={11} className="text-mint" />
              Saved {formatRelative(lastSavedAt)}
            </span>
          )}
          <button
            onClick={saveNow}
            disabled={!model}
            className={`px-3 py-2 rounded-lg border text-sm flex items-center gap-2 transition
                       disabled:opacity-40 disabled:cursor-not-allowed
                       ${
                         justSaved
                           ? "bg-mint border-mint text-ink-950 font-semibold"
                           : "border-ink-600 hover:border-mint hover:text-mint"
                       }`}
            title="Save the project now"
          >
            {justSaved ? (
              <>
                <Check size={14} /> Saved!
              </>
            ) : (
              <>
                <SaveIcon size={13} /> Save
              </>
            )}
          </button>
          <button
            onClick={resetOrder}
            disabled={!hasChanges}
            className="px-3 py-2 rounded-lg border border-ink-600 hover:border-ink-500
                       text-sm flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            <RotateCcw size={13} /> Reset
          </button>
          <button
            onClick={exportCurrent}
            disabled={!model}
            className="px-3 py-2 rounded-lg bg-mint hover:brightness-110 text-ink-950
                       text-sm font-semibold flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed transition"
            title="Export the project as a JSON file"
          >
            <FileJson size={14} /> Export JSON
          </button>
          <span className="text-xs text-ink-300 capitalize hidden sm:block">{authUser}</span>
          <button
            onClick={handleLogout}
            className="px-2.5 py-2 rounded-lg border border-ink-600 hover:border-red-500 hover:text-red-400 text-xs flex items-center gap-1.5 transition"
            title="Sign out"
          >
            <LogOut size={12} />
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:overflow-hidden">
        {/* LEFT: editor */}
        <section className="scroll-thin p-4 sm:p-6 lg:overflow-y-auto lg:border-r lg:border-ink-600">
          {error && (
            <div className="mb-4 p-3 rounded-lg border border-red-500/40 bg-red-500/10 text-red-300 text-sm">
              {error}
            </div>
          )}
          {model && (
            <>
              <div className="mb-6 rounded-2xl border border-ink-600 bg-gradient-to-br from-ink-800 to-ink-700 p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[10px] uppercase tracking-widest font-bold text-brand-400 bg-brand/15 px-2 py-1 rounded">
                    Header · fixed
                  </span>
                  {model.header.meta && (
                    <span className="text-xs text-ink-300">{model.header.meta}</span>
                  )}
                </div>
                <h2 className="text-xl font-semibold text-ink-100 leading-tight">
                  {model.header.title || "(untitled)"}
                </h2>
              </div>

              <div className="flex items-center justify-between mb-3">
                <h3 className="text-[11px] uppercase tracking-widest font-bold text-ink-300">
                  Sections · drag cards to reorder
                </h3>
                <span className="text-xs text-ink-300">
                  {model.macros.length} sections ·{" "}
                  {model.macros.reduce((acc, m) => acc + m.items.length, 0)} stories
                </span>
              </div>

              <DndContext
                sensors={sensors}
                collisionDetection={collisionDetection}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragEnd={handleDragEnd}
              >
                <SortableContext items={macroIds} strategy={verticalListSortingStrategy}>
                  <div className="flex flex-col gap-3">
                    {model.macros.map((m, i) => (
                      <MacroGroup
                        key={m.id}
                        macro={m}
                        index={i}
                        onRenameMacro={() => editMacro(m.id)}
                        onDeleteMacro={() => deleteMacro(m.id)}
                        onAddItem={() => addItem(m.id)}
                        onRenameItem={(itemId) => renameItem(m.id, itemId)}
                        onDeleteItem={(itemId) => deleteItem(m.id, itemId)}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>

              <button
                onClick={addMacro}
                className="mt-4 w-full border border-dashed border-ink-600 hover:border-brand
                           text-ink-300 hover:text-brand-400 rounded-xl py-3 text-sm
                           flex items-center justify-center gap-2 transition"
              >
                <Plus size={14} /> Add section
              </button>
            </>
          )}

          <details className="mt-6 text-xs text-ink-300">
            <summary className="cursor-pointer hover:text-ink-100">
              CORS proxy (change it if loading fails)
            </summary>
            <div className="mt-2 flex gap-2 flex-wrap">
              {PROXIES.map((p, i) => (
                <label
                  key={i}
                  className={`px-3 py-1.5 rounded-md border cursor-pointer text-xs transition
                    ${
                      proxy === p
                        ? "border-brand bg-brand/15 text-ink-100"
                        : "border-ink-600 hover:border-ink-500"
                    }`}
                >
                  <input
                    type="radio"
                    name="proxy"
                    checked={proxy === p}
                    onChange={() => setProxy(p)}
                    className="hidden"
                  />
                  {PROXY_LABELS[i]}
                </label>
              ))}
            </div>
          </details>
        </section>

        {/* RIGHT: live preview */}
        <section className="border-t border-ink-600 p-4 sm:p-6 flex flex-col min-w-0 min-h-[65vh] lg:min-h-0 lg:border-t-0 lg:overflow-hidden">
          <div className="flex flex-col gap-3 mb-3 sm:flex-row sm:items-center sm:justify-between">
            <h3 className="text-[11px] uppercase tracking-widest font-bold text-ink-300">
              Live preview
            </h3>
            <div className="flex flex-wrap items-center gap-2">
              {hasChanges && (
                <span className="text-[10px] uppercase tracking-widest font-bold text-mint bg-mint/10 px-2 py-1 rounded">
                  Modified
                </span>
              )}
              {previewEditMode ? (
                <>
                  <button
                    onClick={discardPreviewEdit}
                    className="px-2.5 py-1.5 rounded-md border border-ink-600 hover:border-red-500 hover:text-red-400 text-xs flex items-center gap-1.5 transition"
                    title="Discard all changes made in edit mode and return to the previous version"
                  >
                    <X size={12} /> Discard changes
                  </button>
                  <button
                    onClick={commitPreviewEdit}
                    className="px-2.5 py-1.5 rounded-md bg-mint hover:brightness-110 text-ink-950 text-xs font-semibold flex items-center gap-1.5"
                    title="Confirm changes and return to the preview"
                  >
                    ✓ Confirm
                  </button>
                </>
              ) : (
                <button
                  onClick={enterPreviewEdit}
                  disabled={!previewURL}
                  className="px-2.5 py-1.5 rounded-md text-xs flex items-center gap-1.5 transition border
                             border-ink-600 hover:border-brand text-ink-300 hover:text-brand-400
                             disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Edit inline directly in the preview"
                >
                  <Pencil size={12} /> Edit
                </button>
              )}
              <button
                onClick={() => setFullscreen(true)}
                disabled={!previewURL}
                className="px-2.5 py-1.5 rounded-md border border-ink-600 hover:border-brand
                           text-ink-300 hover:text-brand-400 disabled:opacity-40 disabled:cursor-not-allowed
                           text-xs flex items-center gap-1.5 transition"
                title="Open fullscreen preview"
              >
                <Maximize2 size={12} /> Full screen
              </button>
            </div>
          </div>
          <div className="flex-1 min-h-[50vh] rounded-xl border border-ink-600 overflow-hidden bg-[#0c0d11] lg:min-h-0">
            {previewURL ? (
              <iframe
                src={previewURL}
                title="Preview"
                className="w-full h-full"
                sandbox="allow-same-origin allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-ink-500 bg-ink-800">
                <span className="text-sm">The preview will appear here after loading.</span>
              </div>
            )}
          </div>
        </section>
      </main>

      {mobileActionsOpen && (
        <div
          className="fixed inset-0 z-40 bg-ink-950/80 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileActionsOpen(false)}
        >
          <div
            className="absolute inset-x-4 top-16 rounded-2xl border border-ink-600 bg-ink-900 shadow-2xl p-4 flex flex-col gap-2"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 mb-1">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-ink-100 truncate">
                  {model.header?.title || "(untitled)"}
                </div>
                <div className="text-[11px] text-ink-300 truncate capitalize">{authUser}</div>
              </div>
              <button
                onClick={() => setMobileActionsOpen(false)}
                className="w-9 h-9 rounded-lg border border-ink-600 hover:border-red-500 hover:text-red-400 flex items-center justify-center"
                aria-label="Close project actions"
              >
                <X size={14} />
              </button>
            </div>

            {lastSavedAt && (
              <div
                className="text-[11px] text-ink-300 flex items-center gap-1.5 px-1 pb-1"
                title={`Saved automatically in the browser · ${new Date(lastSavedAt).toLocaleString()}`}
              >
                <SaveIcon size={11} className="text-mint" />
                Saved {formatRelative(lastSavedAt)}
              </div>
            )}
            <button
              onClick={() => {
                setMobileActionsOpen(false);
                backToWelcome();
              }}
              className="w-full px-3 py-3 rounded-xl border border-ink-600 hover:border-brand text-sm flex items-center gap-2 transition"
            >
              <History size={14} /> Projects
            </button>
            <button
              onClick={() => {
                saveNow();
                setMobileActionsOpen(false);
              }}
              disabled={!model}
              className={`w-full px-3 py-3 rounded-xl border text-sm flex items-center gap-2 transition disabled:opacity-40 disabled:cursor-not-allowed ${
                justSaved
                  ? "bg-mint border-mint text-ink-950 font-semibold"
                  : "border-ink-600 hover:border-mint hover:text-mint"
              }`}
            >
              {justSaved ? (
                <>
                  <Check size={14} /> Saved!
                </>
              ) : (
                <>
                  <SaveIcon size={13} /> Save
                </>
              )}
            </button>
            <button
              onClick={() => {
                resetOrder();
                setMobileActionsOpen(false);
              }}
              disabled={!hasChanges}
              className="w-full px-3 py-3 rounded-xl border border-ink-600 hover:border-ink-500 text-sm flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              <RotateCcw size={13} /> Reset
            </button>
            <button
              onClick={() => {
                exportCurrent();
                setMobileActionsOpen(false);
              }}
              disabled={!model}
              className="w-full px-3 py-3 rounded-xl bg-mint hover:brightness-110 text-ink-950 text-sm font-semibold flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              <FileJson size={14} /> Export JSON
            </button>
            <button
              onClick={() => {
                handleLogout();
                setMobileActionsOpen(false);
              }}
              className="w-full px-3 py-3 rounded-xl border border-ink-600 hover:border-red-500 hover:text-red-400 text-sm flex items-center gap-2 transition"
            >
              <LogOut size={13} /> Sign out
            </button>
          </div>
        </div>
      )}

      {/* Editor modal (story or section) */}
      {editingTarget && (
        <NewsEditor
          key={editingTarget.item.id + ":" + editingTarget.kind}
          item={editingTarget.item}
          kind={editingTarget.kind}
          onSave={applyEdit}
          onClose={() => setEditing(null)}
        />
      )}

      {/* Fullscreen preview overlay */}
      {fullscreen && previewURL && (
        <div className="fixed inset-0 z-50 bg-ink-950/95 backdrop-blur-sm flex flex-col">
          <div className="flex items-center justify-between px-5 py-3 border-b border-ink-600 bg-ink-900">
            <div className="text-sm font-medium text-ink-100 flex items-center gap-2">
              <Newspaper size={14} className="text-brand-400" />
              Preview · {model?.header.title || "Preview"}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={exportCurrent}
                className="px-3 py-1.5 rounded-md bg-mint text-ink-950 text-xs font-semibold flex items-center gap-1.5"
              >
                <FileJson size={12} /> Export JSON
              </button>
              <button
                onClick={() => setFullscreen(false)}
                className="px-3 py-1.5 rounded-md border border-ink-600 hover:border-brand text-xs flex items-center gap-1.5"
                title="Close (Esc)"
              >
                <Minimize2 size={12} /> Close
              </button>
              <button
                onClick={() => setFullscreen(false)}
                className="w-8 h-8 rounded-md border border-ink-600 hover:border-red-500 hover:text-red-400 flex items-center justify-center"
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </div>
          </div>
          <iframe
            src={previewURL}
            title="Fullscreen preview"
            className="flex-1 w-full bg-[#0c0d11]"
            sandbox="allow-same-origin allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals"
          />
        </div>
      )}
    </div>
  );
}

// ─── Utilities ──────────────────────────────────────────────────────────────
function cloneModel(m: BlogModel): BlogModel {
  return {
    ...m,
    macros: m.macros.map((mc: MacroSection) => ({ ...mc, items: mc.items.map((i: NewsItem) => ({ ...i })) })),
  };
}
function escapeHTML(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}
