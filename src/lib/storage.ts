import type { BlogModel, MacroSection, NewsItem } from "./parser";

const DB_NAME = "aisocratic-blog-maker";
const DB_VERSION = 1;
const PROJECTS_STORE = "projects";
const PROJECTS_BY_USER_INDEX = "by-userId";
const SOURCES_STORE = "source-cache";
const REMOTE_STORAGE_SYNC_ENABLED = false;

const LEGACY_PROJECT_PREFIX = "aperitivo:project:";
// v3 wraps the exported payload as `{ project, syncState }` so the shared project
// document stays persistence-agnostic while repository-specific sync state travels separately.
const FILE_FORMAT = "aisocratic-project-v3";

export type ProjectDocument = {
  id: string;
  sourceUrl: string;
  title: string;
  createdAt: number;
  savedAt: number;
  model: BlogModel;
};

export type ProjectSyncState = {
  remoteId: string | null;
  revision: string | null;
  lastSyncedAt?: number | null;
  seedProject?: ProjectDocument | null;
  pendingOperations?: ProjectChangeOperation[] | null;
};

export type ProjectSnapshot = {
  project: ProjectDocument;
  syncState?: ProjectSyncState | null;
};

export type ProjectChangeOperation =
  | { type: "set-post-title"; title: string }
  | { type: "update-macro"; macroId: string; title?: string; introHTML?: string }
  | { type: "reorder-macros"; macroIds: string[] }
  | { type: "add-macro"; macro: MacroSection; index: number }
  | { type: "delete-macro"; macroId: string }
  | { type: "add-item"; macroId: string; item: NewsItem; index: number }
  | { type: "delete-item"; macroId: string; itemId: string }
  | { type: "update-item"; itemId: string; title?: string; bodyHTML?: string }
  | { type: "move-item"; itemId: string; toMacroId: string; toIndex: number }
  | { type: "reset-project" };

export type CachedSource = {
  sourceUrl: string;
  html: string;
  model: BlogModel;
  fetchedAt: number;
};

export interface ProjectRepository {
  listProjects(userId: string): Promise<ProjectDocument[]>;
  loadProject(userId: string, id: string): Promise<ProjectDocument | null>;
  loadProjectSnapshot(userId: string, id: string): Promise<ProjectSnapshot | null>;
  saveProject(userId: string, project: ProjectDocument, syncState?: ProjectSyncState | null): Promise<boolean>;
  saveProjectSnapshot(userId: string, snapshot: ProjectSnapshot): Promise<boolean>;
  deleteProject(userId: string, id: string): Promise<void>;
  importProjectFromFile(file: File, userId: string): Promise<ProjectSnapshot>;
  exportProjectToFile(snapshot: ProjectSnapshot): void;
}

export interface SourceCacheRepository {
  loadCachedSource(url: string): Promise<CachedSource | null>;
  saveCachedSource(source: CachedSource): Promise<boolean>;
}

type LegacyProjectShape = Partial<ProjectDocument> &
  Partial<{
    url: string;
    sourceUrl: string;
    remoteIssueNumber: number | null;
    remoteRevision: string | null;
    sync: ProjectSyncState | null;
    project: ProjectDocument;
    syncState: ProjectSyncState | null;
  }> & {
    model?: BlogModel;
    savedAt?: number;
  };

type StoredProjectRecord = {
  // IndexedDB keyPath lives at the record root, so we mirror `project.id` here.
  id: string;
  userId: string;
  project: ProjectDocument;
  syncState?: ProjectSyncState | null;
};

let dbPromise: Promise<IDBDatabase> | null = null;

export const projectRepository: ProjectRepository = {
  async listProjects(userId) {
    const normalizedUserId = normalizeUserId(userId);
    if (!normalizedUserId) return [];

    await migrateLegacyLocalStorageProjects(normalizedUserId);

    try {
      const db = await openDatabase();
      const tx = db.transaction(PROJECTS_STORE, "readonly");
      const raw = await requestAsPromise<unknown[]>(
        tx.objectStore(PROJECTS_STORE).index(PROJECTS_BY_USER_INDEX).getAll(normalizedUserId)
      );
      await waitForTransaction(tx);
      return raw
        .map((value) => toStoredProjectRecord(value))
        .filter((record): record is StoredProjectRecord => record !== null)
        .map((record) => record.project)
        .sort((a, b) => b.savedAt - a.savedAt);
    } catch {
      return [];
    }
  },

  async loadProject(userId, id) {
    const snapshot = await this.loadProjectSnapshot(userId, id);
    return snapshot?.project ?? null;
  },

  async loadProjectSnapshot(userId, id) {
    const normalizedUserId = normalizeUserId(userId);
    if (!normalizedUserId) return null;

    try {
      const db = await openDatabase();
      const tx = db.transaction(PROJECTS_STORE, "readonly");
      const raw = await requestAsPromise<unknown>(tx.objectStore(PROJECTS_STORE).get(id));
      await waitForTransaction(tx);
      const record = toStoredProjectRecord(raw);
      if (!record || record.userId !== normalizedUserId) return null;
      return { project: record.project, syncState: record.syncState ?? null };
    } catch {
      return null;
    }
  },

  async saveProject(userId, project, syncState) {
    return this.saveProjectSnapshot(userId, { project, syncState });
  },

  async saveProjectSnapshot(userId, snapshot) {
    const normalizedUserId = normalizeUserId(userId);
    if (!normalizedUserId) return false;

    try {
      const db = await openDatabase();
      const tx = db.transaction(PROJECTS_STORE, "readwrite");
      tx.objectStore(PROJECTS_STORE).put(
        toStoredProjectRecordValue(normalizedUserId, snapshot.project, snapshot.syncState)
      );
      await waitForTransaction(tx);
      return true;
    } catch {
      return false;
    }
  },

  async deleteProject(userId, id) {
    const existing = await this.loadProjectSnapshot(userId, id);
    if (!existing) return;

    try {
      const db = await openDatabase();
      const tx = db.transaction(PROJECTS_STORE, "readwrite");
      tx.objectStore(PROJECTS_STORE).delete(id);
      await waitForTransaction(tx);
    } catch {
      /* noop */
    }
  },

  async importProjectFromFile(file, userId) {
    const text = await file.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("File is not valid JSON.");
    }

    const snapshot = parseImportedProject(parsed, file.name);
    const project: ProjectDocument = {
      ...snapshot.project,
      id: newProjectId(),
      savedAt: Date.now(),
    };
    const normalizedSnapshot = {
      project: normalizeProject(project),
      syncState: normalizeSyncState(snapshot.syncState),
    };

    if (!(await this.saveProjectSnapshot(userId, normalizedSnapshot))) {
      throw new Error("Unable to save to the browser database (IndexedDB).");
    }

    return normalizedSnapshot;
  },

  exportProjectToFile(snapshot) {
    const payload = {
      _format: FILE_FORMAT,
      project: normalizeProject(snapshot.project),
      syncState: normalizeSyncState(snapshot.syncState),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `aisocratic-${slugify(snapshot.project.title)}-${ymd(snapshot.project.savedAt)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};

export const sourceCacheRepository: SourceCacheRepository = {
  async loadCachedSource(url) {
    const sourceUrl = canonicalizeSourceUrl(url);
    if (!sourceUrl) return null;

    try {
      const db = await openDatabase();
      const tx = db.transaction(SOURCES_STORE, "readonly");
      const raw = await requestAsPromise<unknown>(tx.objectStore(SOURCES_STORE).get(sourceUrl));
      await waitForTransaction(tx);
      return isCachedSource(raw) ? { ...raw, sourceUrl } : null;
    } catch {
      return null;
    }
  },

  async saveCachedSource(source) {
    const normalized: CachedSource = {
      ...source,
      sourceUrl: canonicalizeSourceUrl(source.sourceUrl),
    };
    if (!normalized.sourceUrl) return false;

    try {
      const db = await openDatabase();
      const tx = db.transaction(SOURCES_STORE, "readwrite");
      tx.objectStore(SOURCES_STORE).put(normalized);
      await waitForTransaction(tx);
      return true;
    } catch {
      return false;
    }
  },
};

export function newProjectId(): string {
  return "p_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function cloneProjectDocument(project: ProjectDocument): ProjectDocument {
  if (typeof structuredClone === "function") return structuredClone(project);
  return JSON.parse(JSON.stringify(project)) as ProjectDocument;
}

/**
 * Replays a sequence of generic project operations on top of a stable seed snapshot.
 *
 * @param seedProject provider-agnostic base project used as the reconstruction seed
 * @param operations ordered atomic operations to apply on top of the seed snapshot
 * @param savedAt optional timestamp for the reconstructed project; defaults to the seed timestamp
 * @returns the reconstructed project document after all operations have been applied
 */
export function applyProjectOperations(
  seedProject: ProjectDocument,
  operations: ProjectChangeOperation[],
  savedAt = seedProject.savedAt
): ProjectDocument {
  let current = cloneProjectDocument(seedProject);
  for (const operation of operations) {
    current = applyProjectOperation(current, operation, seedProject);
  }
  return normalizeProject({
    ...current,
    savedAt,
    title: current.model.header?.title || current.title || current.sourceUrl,
  });
}

export function normalizeUserId(userId: string): string {
  return userId.trim().toLowerCase();
}

export function canonicalizeSourceUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    }
    if (
      (parsed.protocol === "https:" && parsed.port === "443") ||
      (parsed.protocol === "http:" && parsed.port === "80")
    ) {
      parsed.port = "";
    }
    return parsed.href;
  } catch {
    return trimmed;
  }
}

function openDatabase(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;

        if (!db.objectStoreNames.contains(PROJECTS_STORE)) {
          const projects = db.createObjectStore(PROJECTS_STORE, { keyPath: "id" });
          projects.createIndex(PROJECTS_BY_USER_INDEX, "userId", { unique: false });
        }

        if (!db.objectStoreNames.contains(SOURCES_STORE)) {
          db.createObjectStore(SOURCES_STORE, { keyPath: "sourceUrl" });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Unable to open IndexedDB."));
    });
  }

  return dbPromise;
}

function requestAsPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function waitForTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted."));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed."));
  });
}

function normalizeProject(project: ProjectDocument): ProjectDocument {
  const sourceUrl = resolveProjectSourceUrl(project);
  return {
    ...project,
    sourceUrl,
    title: project.title || project.model.header?.title || sourceUrl,
  };
}

function resolveProjectSourceUrl(project: {
  sourceUrl?: string;
  url?: string;
  model: Pick<BlogModel, "baseHref">;
}): string {
  return canonicalizeSourceUrl(project.sourceUrl || project.url || project.model.baseHref || "");
}

function normalizeSyncState(syncState?: ProjectSyncState | null): ProjectSyncState | null {
  if (!syncState) return null;

  const seedProject = normalizeSeedProject(syncState.seedProject);
  if (!REMOTE_STORAGE_SYNC_ENABLED) {
    return seedProject
      ? {
          remoteId: null,
          revision: null,
          lastSyncedAt: null,
          seedProject,
          pendingOperations: null,
        }
      : null;
  }

  return {
    remoteId: typeof syncState.remoteId === "string" ? syncState.remoteId : null,
    revision: typeof syncState.revision === "string" ? syncState.revision : null,
    lastSyncedAt: typeof syncState.lastSyncedAt === "number" ? syncState.lastSyncedAt : null,
    seedProject,
    pendingOperations: normalizeProjectChangeOperations(syncState.pendingOperations),
  };
}

function toStoredProjectRecordValue(
  userId: string,
  project: ProjectDocument,
  syncState?: ProjectSyncState | null
): StoredProjectRecord {
  const normalizedProject = normalizeProject(project);
  return {
    id: normalizedProject.id,
    userId,
    project: normalizedProject,
    syncState: normalizeSyncState(syncState),
  };
}

function toStoredProjectRecord(value: unknown): StoredProjectRecord | null {
  if (!value || typeof value !== "object") return null;

  if ("project" in value && "userId" in value) {
    const candidate = value as {
      id?: unknown;
      userId?: unknown;
      project?: unknown;
      syncState?: unknown;
    };
    if (typeof candidate.userId !== "string" || !isProjectDocument(candidate.project)) return null;
    return {
      id: candidate.project.id,
      userId: normalizeUserId(candidate.userId),
      project: normalizeProject(candidate.project),
      syncState: normalizeSyncState(candidate.syncState as ProjectSyncState | null | undefined),
    };
  }

  if ("model" in value && "userId" in value) {
    const legacy = value as LegacyProjectShape & { id?: unknown; userId?: unknown };
    if (typeof legacy.userId !== "string" || !legacy.model || !Array.isArray(legacy.model.macros)) return null;
    const resolvedSourceUrl = resolveProjectSourceUrl({
      sourceUrl: legacy.sourceUrl,
      url: legacy.url,
      model: legacy.model,
    });
    const project = normalizeProject({
      id: typeof legacy.id === "string" ? legacy.id : newProjectId(),
      sourceUrl: resolvedSourceUrl,
      title: legacy.title || legacy.model.header?.title || resolvedSourceUrl,
      createdAt: typeof legacy.createdAt === "number" ? legacy.createdAt : Date.now(),
      savedAt: typeof legacy.savedAt === "number" ? legacy.savedAt : Date.now(),
      model: legacy.model,
    });
    return {
      id: project.id,
      userId: normalizeUserId(legacy.userId),
      project,
      syncState: normalizeSyncState({
        // Legacy exports persisted a numeric GitHub issue number; the repository now
        // exposes a provider-agnostic string remoteId so other backends can reuse it.
        remoteId: convertIssueNumberToRemoteId(legacy.remoteIssueNumber),
        revision: typeof legacy.remoteRevision === "string" ? legacy.remoteRevision : null,
      }),
    };
  }

  return null;
}

function parseImportedProject(parsed: unknown, fileName: string): ProjectSnapshot {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Unrecognized file: missing project format.");
  }

  const candidate = parsed as LegacyProjectShape;
  const importedProject = isProjectDocument(candidate.project) ? candidate.project : extractLegacyProject(candidate, fileName);
  const normalizedProject = normalizeProject({
    ...importedProject,
    id: importedProject.id || newProjectId(),
  });

  return {
    project: normalizedProject,
    syncState: normalizeSyncState(
      candidate.syncState ||
        candidate.sync || {
          // Legacy exports persisted a numeric GitHub issue number; the repository now
          // exposes a provider-agnostic string remoteId so other backends can reuse it.
          remoteId: convertIssueNumberToRemoteId(candidate.remoteIssueNumber),
          revision: typeof candidate.remoteRevision === "string" ? candidate.remoteRevision : null,
        }
    ),
  };
}

function extractLegacyProject(candidate: LegacyProjectShape, fileName: string): ProjectDocument {
  const model = candidate.model;
  if (!model || !Array.isArray(model.macros)) {
    throw new Error("Invalid file: 'model.macros' is missing or is not an array.");
  }

  const now = Date.now();
  const sourceUrl = resolveProjectSourceUrl({
    sourceUrl: candidate.sourceUrl,
    url: candidate.url,
    model,
  });
  return {
    id: typeof candidate.id === "string" ? candidate.id : newProjectId(),
    sourceUrl,
    title: candidate.title || model.header?.title || fileName.replace(/\.json$/i, ""),
    createdAt: typeof candidate.createdAt === "number" ? candidate.createdAt : now,
    savedAt: typeof candidate.savedAt === "number" ? candidate.savedAt : now,
    model,
  };
}

function isProjectDocument(value: unknown): value is ProjectDocument {
  return (
    !!value &&
    typeof value === "object" &&
    "id" in value &&
    "model" in value &&
    "sourceUrl" in value
  );
}

function convertIssueNumberToRemoteId(issueNumber: unknown): string | null {
  return typeof issueNumber === "number" ? String(issueNumber) : null;
}

function normalizeSeedProject(seedProject: unknown): ProjectDocument | null {
  return isProjectDocument(seedProject) ? normalizeProject(seedProject) : null;
}

export function normalizeProjectChangeOperations(value: unknown): ProjectChangeOperation[] | null {
  if (!Array.isArray(value)) return null;
  const operations = value
    .map((operation) => normalizeProjectChangeOperation(operation))
    .filter((operation): operation is ProjectChangeOperation => operation !== null);
  return operations.length ? operations : null;
}

function normalizeProjectChangeOperation(value: unknown): ProjectChangeOperation | null {
  if (!value || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string") return null;
  const candidate = value as Record<string, unknown> & { type: ProjectChangeOperation["type"] };
  switch (candidate.type) {
    case "set-post-title":
      return typeof candidate.title === "string" ? { type: candidate.type, title: candidate.title } : null;
    case "update-macro":
      return typeof candidate.macroId === "string" &&
        (typeof candidate.title === "string" || typeof candidate.introHTML === "string")
        ? {
            type: candidate.type,
            macroId: candidate.macroId,
            ...(typeof candidate.title === "string" ? { title: candidate.title } : {}),
            ...(typeof candidate.introHTML === "string" ? { introHTML: candidate.introHTML } : {}),
          }
        : null;
    case "reorder-macros":
      return Array.isArray(candidate.macroIds) && candidate.macroIds.every((id) => typeof id === "string")
        ? { type: candidate.type, macroIds: [...candidate.macroIds] }
        : null;
    case "add-macro":
      return isMacroSection(candidate.macro) && typeof candidate.index === "number"
        ? { type: candidate.type, macro: cloneMacroSection(candidate.macro), index: candidate.index }
        : null;
    case "delete-macro":
      return typeof candidate.macroId === "string" ? { type: candidate.type, macroId: candidate.macroId } : null;
    case "add-item":
      return isNewsItem(candidate.item) && typeof candidate.macroId === "string" && typeof candidate.index === "number"
        ? { type: candidate.type, macroId: candidate.macroId, item: cloneNewsItem(candidate.item), index: candidate.index }
        : null;
    case "delete-item":
      return typeof candidate.macroId === "string" && typeof candidate.itemId === "string"
        ? { type: candidate.type, macroId: candidate.macroId, itemId: candidate.itemId }
        : null;
    case "update-item":
      return typeof candidate.itemId === "string" &&
        (typeof candidate.title === "string" || typeof candidate.bodyHTML === "string")
        ? {
            type: candidate.type,
            itemId: candidate.itemId,
            ...(typeof candidate.title === "string" ? { title: candidate.title } : {}),
            ...(typeof candidate.bodyHTML === "string" ? { bodyHTML: candidate.bodyHTML } : {}),
          }
        : null;
    case "move-item":
      return typeof candidate.itemId === "string" &&
        typeof candidate.toMacroId === "string" &&
        typeof candidate.toIndex === "number"
        ? { type: candidate.type, itemId: candidate.itemId, toMacroId: candidate.toMacroId, toIndex: candidate.toIndex }
        : null;
    case "reset-project":
      return { type: candidate.type };
    default:
      return null;
  }
}

function applyProjectOperation(
  project: ProjectDocument,
  operation: ProjectChangeOperation,
  seedProject: ProjectDocument
): ProjectDocument {
  if (operation.type === "reset-project") {
    return cloneProjectDocument(seedProject);
  }

  const next = cloneProjectDocument(project);
  switch (operation.type) {
    case "set-post-title":
      if (next.model.header) next.model.header.title = operation.title;
      next.title = operation.title || next.sourceUrl;
      return next;
    case "update-macro": {
      const macro = next.model.macros.find((item) => item.id === operation.macroId);
      if (!macro) return project;
      if (typeof operation.title === "string") {
        macro.title = operation.title;
        macro.headingHTML = `<h1 id="${macro.id}" class="macro-heading">${escapeHTML(operation.title)}</h1>`;
      }
      if (typeof operation.introHTML === "string") macro.introHTML = operation.introHTML;
      return next;
    }
    case "reorder-macros": {
      const order = new Map(operation.macroIds.map((id, index) => [id, index]));
      next.model.macros = [...next.model.macros].sort((a, b) => {
        const left = order.get(a.id);
        const right = order.get(b.id);
        if (left === undefined && right === undefined) return 0;
        if (left === undefined) return 1;
        if (right === undefined) return -1;
        return left - right;
      });
      return next;
    }
    case "add-macro": {
      const index = clampIndex(operation.index, next.model.macros.length + 1);
      next.model.macros.splice(index, 0, cloneMacroSection(operation.macro));
      return next;
    }
    case "delete-macro":
      next.model.macros = next.model.macros.filter((macro) => macro.id !== operation.macroId);
      return next;
    case "add-item": {
      const macro = next.model.macros.find((item) => item.id === operation.macroId);
      if (!macro) return project;
      const index = clampIndex(operation.index, macro.items.length + 1);
      macro.items.splice(index, 0, cloneNewsItem(operation.item));
      return next;
    }
    case "delete-item": {
      const macro = next.model.macros.find((item) => item.id === operation.macroId);
      if (!macro) return project;
      macro.items = macro.items.filter((item) => item.id !== operation.itemId);
      return next;
    }
    case "update-item": {
      const item = findNewsItem(next, operation.itemId);
      if (!item) return project;
      if (typeof operation.title === "string") {
        item.title = operation.title;
        item.headingHTML = `<h${item.level} id="${item.id}" class="news-heading">${escapeHTML(operation.title)}</h${item.level}>`;
      }
      if (typeof operation.bodyHTML === "string") {
        item.bodyHTML = operation.bodyHTML;
        updateDerivedItemFields(item);
      }
      return next;
    }
    case "move-item": {
      const located = takeNewsItem(next, operation.itemId);
      if (!located) return project;
      const targetMacro = next.model.macros.find((item) => item.id === operation.toMacroId);
      if (!targetMacro) return project;
      const index = clampIndex(operation.toIndex, targetMacro.items.length + 1);
      targetMacro.items.splice(index, 0, located.item);
      return next;
    }
  }
}

function isMacroSection(value: unknown): value is MacroSection {
  return !!value && typeof value === "object" && "id" in value && "items" in value;
}

function isNewsItem(value: unknown): value is NewsItem {
  return !!value && typeof value === "object" && "id" in value && "bodyHTML" in value;
}

function cloneMacroSection(macro: MacroSection): MacroSection {
  if (typeof structuredClone === "function") return structuredClone(macro);
  return JSON.parse(JSON.stringify(macro)) as MacroSection;
}

function cloneNewsItem(item: NewsItem): NewsItem {
  if (typeof structuredClone === "function") return structuredClone(item);
  return JSON.parse(JSON.stringify(item)) as NewsItem;
}

function findNewsItem(project: ProjectDocument, itemId: string): NewsItem | null {
  for (const macro of project.model.macros) {
    const item = macro.items.find((entry) => entry.id === itemId);
    if (item) return item;
  }
  return null;
}

function takeNewsItem(project: ProjectDocument, itemId: string): { item: NewsItem; macroId: string } | null {
  for (const macro of project.model.macros) {
    const index = macro.items.findIndex((entry) => entry.id === itemId);
    if (index >= 0) {
      const [item] = macro.items.splice(index, 1);
      return { item, macroId: macro.id };
    }
  }
  return null;
}

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(length, Math.trunc(index)));
}

function updateDerivedItemFields(item: NewsItem): void {
  if (typeof document === "undefined") {
    item.snippet = item.snippet || "";
    return;
  }
  const tmp = document.createElement("div");
  tmp.innerHTML = item.bodyHTML;
  item.snippet = (tmp.textContent || "").replace(/\s+/g, " ").trim().slice(0, 220);
  const firstImg = tmp.querySelector("img");
  item.imageUrl = firstImg?.getAttribute("src") || undefined;
}

function escapeHTML(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isCachedSource(value: unknown): value is CachedSource {
  return !!value && typeof value === "object" && "sourceUrl" in value && "model" in value && "html" in value;
}

async function migrateLegacyLocalStorageProjects(userId: string): Promise<void> {
  if (typeof localStorage === "undefined") return;

  const entries: Array<{ key: string; snapshot: ProjectSnapshot }> = [];

  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(LEGACY_PROJECT_PREFIX)) continue;

      const raw = localStorage.getItem(key);
      if (!raw) continue;

      try {
        const parsed = JSON.parse(raw) as LegacyProjectShape;
        const snapshot = parseImportedProject(parsed, key.slice(LEGACY_PROJECT_PREFIX.length));
        entries.push({ key, snapshot });
      } catch {
        /* skip malformed */
      }
    }
  } catch {
    return;
  }

  if (entries.length === 0) return;

  const migratedKeys: string[] = [];
  for (const entry of entries) {
    if (await projectRepository.saveProjectSnapshot(userId, entry.snapshot)) {
      migratedKeys.push(entry.key);
    }
  }

  for (const key of migratedKeys) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* noop */
    }
  }
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60) || "project";
}

function ymd(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.round(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} d ago`;
}
