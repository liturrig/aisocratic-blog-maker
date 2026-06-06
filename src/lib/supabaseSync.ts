import {
  applyProjectOperations,
  canonicalizeSourceUrl,
  cloneProjectDocument,
  normalizeProjectChangeOperations,
  normalizeUserId,
  type ProjectChangeOperation,
  type ProjectDocument,
  type ProjectSnapshot,
  type ProjectSyncState,
} from "./storage";

const SETTINGS_STORAGE_KEY = "aisocratic:supabase-sync-settings";
const TOKEN_STORAGE_KEY = "aisocratic:supabase-sync-token";
const MAX_PROJECT_TITLE_LENGTH = 240;
const EXPLICIT_EMPTY_VALUE = "__aisocratic_explicit_empty__";
const ENV_SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL?.trim() ?? "";
const ENV_SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "";

export const DEFAULT_SUPABASE_OBJECT_BUCKET = "aisocratic-remote-sync";
export const DEFAULT_SUPABASE_PROJECTS_TABLE = "aisocratic_remote_projects";
export const DEFAULT_SUPABASE_EVENTS_TABLE = "aisocratic_remote_events";

type PersistedSupabaseSyncSettings = Partial<
  Pick<SupabaseSyncSettings, "projectUrl" | "bucket" | "projectsTable" | "eventsTable">
>;

type SupabaseProjectRecord = {
  id: string;
  project_id: string;
  user_id: string;
  source_url: string;
  source_seed: string;
  title: string;
  seed_object_path: string;
  seed_revision: string;
  latest_revision: string;
  last_synced_at: string;
};

type SupabaseEventRow = {
  id?: number;
  record_id: string;
  project_id: string;
  user_id: string;
  source_seed: string;
  batch_revision: string;
  previous_revision: string | null;
  sequence_index: number;
  operation: ProjectChangeOperation;
  saved_at: number;
  synced_at: string;
};

export type SupabaseSyncSettings = {
  projectUrl: string;
  accessKey: string;
  bucket: string;
  projectsTable: string;
  eventsTable: string;
};

type SupabaseRemoteProject = {
  recordId: string;
  snapshot: ProjectSnapshot;
  foundExisting: boolean;
};

export class SupabaseSyncConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupabaseSyncConflictError";
  }
}

class SupabaseSyncConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupabaseSyncConfigurationError";
  }
}

class SupabaseApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SupabaseApiError";
    this.status = status;
  }
}

export function loadSupabaseSyncSettings(): SupabaseSyncSettings {
  let persisted: PersistedSupabaseSyncSettings = {};
  let accessKey: string | null = null;

  if (typeof localStorage !== "undefined") {
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (raw) persisted = JSON.parse(raw) as PersistedSupabaseSyncSettings;
    } catch {
      /* noop */
    }
  }

  if (typeof sessionStorage !== "undefined") {
    try {
      accessKey = decodeExplicitEmpty(sessionStorage.getItem(TOKEN_STORAGE_KEY));
    } catch {
      /* noop */
    }
  }

  return normalizeSupabaseSyncSettings({
    projectUrl: withEnvFallback(decodeExplicitEmpty(persisted.projectUrl), ENV_SUPABASE_URL),
    accessKey: withEnvFallback(accessKey, ENV_SUPABASE_PUBLISHABLE_KEY),
    bucket: typeof persisted.bucket === "string" ? persisted.bucket : DEFAULT_SUPABASE_OBJECT_BUCKET,
    projectsTable:
      typeof persisted.projectsTable === "string" ? persisted.projectsTable : DEFAULT_SUPABASE_PROJECTS_TABLE,
    eventsTable: typeof persisted.eventsTable === "string" ? persisted.eventsTable : DEFAULT_SUPABASE_EVENTS_TABLE,
  });
}

export function saveSupabaseSyncSettings(settings: SupabaseSyncSettings): SupabaseSyncSettings {
  const normalized = normalizeSupabaseSyncSettings(settings);

  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(
        SETTINGS_STORAGE_KEY,
        JSON.stringify({
          projectUrl: encodeExplicitEmpty(normalized.projectUrl),
          bucket: normalized.bucket,
          projectsTable: normalized.projectsTable,
          eventsTable: normalized.eventsTable,
        })
      );
    } catch {
      /* noop */
    }
  }

  if (typeof sessionStorage !== "undefined") {
    try {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, encodeExplicitEmpty(normalized.accessKey));
    } catch {
      /* noop */
    }
  }

  return normalized;
}

export function isSupabaseSyncConfigured(settings: SupabaseSyncSettings): boolean {
  return Boolean(settings.projectUrl && settings.accessKey);
}

export async function syncProjectToSupabase(
  settings: SupabaseSyncSettings,
  userId: string,
  snapshot: ProjectSnapshot
): Promise<SupabaseRemoteProject> {
  const normalizedSettings = requireSupabaseSyncSettings(settings);
  const normalizedUserId = normalizeUserId(userId);
  const localProject = snapshot.project;
  const sourceSeed = buildSourceSeed(localProject.sourceUrl);
  const existingRecord = await resolveProjectRecord(
    normalizedSettings,
    localProject.id,
    normalizedUserId,
    sourceSeed,
    snapshot.syncState?.remoteId ?? null
  );

  if (existingRecord && existingRecord.project_id !== localProject.id) {
    throw new Error("The configured Supabase record belongs to a different project.");
  }

  const remoteState = existingRecord
    ? await loadRemoteState(normalizedSettings, existingRecord)
    : null;

  if (existingRecord && remoteState && remoteState.revision !== (snapshot.syncState?.revision ?? null)) {
    throw new SupabaseSyncConflictError(
      "The remote Supabase revision changed. Refresh the project from Supabase before syncing again."
    );
  }

  const syncedAt = Date.now();
  const revision =
    snapshot.syncState?.pendingOperations?.length || !existingRecord
      ? createRevision()
      : snapshot.syncState?.revision ?? createRevision();
  const seedProject = toRemoteProjectDocument(snapshot.syncState?.seedProject ?? localProject);
  const recordId = existingRecord?.id ?? createRevision();
  const seedObjectPath = buildSeedObjectPath(localProject.id);

  await uploadSeedObject(normalizedSettings, seedObjectPath, seedProject);

  const record = await upsertProjectRecord(normalizedSettings, {
    id: recordId,
    project_id: localProject.id,
    user_id: normalizedUserId,
    source_url: canonicalizeSourceUrl(localProject.sourceUrl),
    source_seed: sourceSeed,
    title: truncateTitle(localProject.title || localProject.sourceUrl),
    seed_object_path: seedObjectPath,
    seed_revision: revision,
    latest_revision: revision,
    last_synced_at: new Date(syncedAt).toISOString(),
  });

  const pendingOperations = snapshot.syncState?.pendingOperations ?? [];
  if (pendingOperations.length > 0) {
    await insertEventRows(
      normalizedSettings,
      pendingOperations.map((operation, index) => ({
        record_id: record.id,
        project_id: localProject.id,
        user_id: normalizedUserId,
        source_seed: sourceSeed,
        batch_revision: revision,
        previous_revision: remoteState?.revision ?? snapshot.syncState?.revision ?? null,
        sequence_index: index,
        operation,
        saved_at: localProject.savedAt,
        synced_at: new Date(syncedAt).toISOString(),
      }))
    );
  }

  const syncState: ProjectSyncState = {
    remoteId: record.id,
    revision,
    lastSyncedAt: syncedAt,
    seedProject: cloneProjectDocument(seedProject),
    pendingOperations: [],
  };

  return {
    recordId: record.id,
    foundExisting: Boolean(existingRecord),
    snapshot: {
      project: localProject,
      syncState,
    },
  };
}

export async function refreshProjectFromSupabase(
  settings: SupabaseSyncSettings,
  userId: string,
  projectId: string,
  sourceUrl: string,
  remoteId?: string | null
): Promise<SupabaseRemoteProject> {
  const normalizedSettings = requireSupabaseSyncSettings(settings);
  const normalizedUserId = normalizeUserId(userId);
  const sourceSeed = buildSourceSeed(sourceUrl);
  const record = await resolveProjectRecord(normalizedSettings, projectId, normalizedUserId, sourceSeed, remoteId ?? null);
  if (!record) {
    throw new Error("No Supabase record found for this project.");
  }
  if (record.project_id !== projectId) {
    throw new Error("The configured Supabase record belongs to a different project.");
  }

  const remoteState = await loadRemoteState(normalizedSettings, record);
  return {
    recordId: record.id,
    foundExisting: true,
    snapshot: {
      project: remoteState.project,
      syncState: {
        remoteId: record.id,
        revision: remoteState.revision,
        lastSyncedAt: remoteState.syncedAt,
        seedProject: cloneProjectDocument(remoteState.seedProject),
        pendingOperations: [],
      },
    },
  };
}

function normalizeSupabaseSyncSettings(settings: SupabaseSyncSettings): SupabaseSyncSettings {
  return {
    projectUrl: normalizeProjectUrl(settings.projectUrl),
    accessKey: settings.accessKey.trim(),
    bucket: settings.bucket.trim() || DEFAULT_SUPABASE_OBJECT_BUCKET,
    projectsTable: settings.projectsTable.trim() || DEFAULT_SUPABASE_PROJECTS_TABLE,
    eventsTable: settings.eventsTable.trim() || DEFAULT_SUPABASE_EVENTS_TABLE,
  };
}

function requireSupabaseSyncSettings(settings: SupabaseSyncSettings): SupabaseSyncSettings {
  const normalized = normalizeSupabaseSyncSettings(settings);
  if (!normalized.projectUrl || !normalized.accessKey) {
    throw new SupabaseSyncConfigurationError(
      "Configure the Supabase project URL and API key before using remote sync."
    );
  }
  return normalized;
}

function normalizeProjectUrl(projectUrl: string): string {
  return projectUrl.trim().replace(/\/+$/, "");
}

function withEnvFallback(value: string | null | undefined, fallback: string): string {
  if (value === null || value === undefined) return fallback;
  return value === "" ? "" : value;
}

function encodeExplicitEmpty(value: string): string {
  return value === "" ? EXPLICIT_EMPTY_VALUE : value;
}

function decodeExplicitEmpty(value: string | undefined | null): string | null {
  if (value === null || value === undefined) return null;
  return value === EXPLICIT_EMPTY_VALUE ? "" : value;
}

async function resolveProjectRecord(
  settings: SupabaseSyncSettings,
  projectId: string,
  userId: string,
  sourceSeed: string,
  remoteId: string | null
): Promise<SupabaseProjectRecord | null> {
  if (remoteId) {
    const direct = await getProjectRecordById(settings, remoteId);
    if (direct) return direct;
  }
  return findProjectRecord(settings, projectId, userId, sourceSeed);
}

async function getProjectRecordById(settings: SupabaseSyncSettings, remoteId: string): Promise<SupabaseProjectRecord | null> {
  const params = new URLSearchParams({
    select: "*",
    id: `eq.${remoteId}`,
    limit: "1",
  });
  const rows = await requestSupabaseJson<SupabaseProjectRecord[]>(settings, `/rest/v1/${settings.projectsTable}?${params}`);
  return rows[0] ?? null;
}

async function findProjectRecord(
  settings: SupabaseSyncSettings,
  projectId: string,
  userId: string,
  sourceSeed: string
): Promise<SupabaseProjectRecord | null> {
  const params = new URLSearchParams({
    select: "*",
    project_id: `eq.${projectId}`,
    user_id: `eq.${userId}`,
    source_seed: `eq.${sourceSeed}`,
    limit: "1",
  });
  const rows = await requestSupabaseJson<SupabaseProjectRecord[]>(settings, `/rest/v1/${settings.projectsTable}?${params}`);
  return rows[0] ?? null;
}

async function upsertProjectRecord(
  settings: SupabaseSyncSettings,
  record: SupabaseProjectRecord
): Promise<SupabaseProjectRecord> {
  const params = new URLSearchParams({ on_conflict: "id", select: "*" });
  const rows = await requestSupabaseJson<SupabaseProjectRecord[]>(settings, `/rest/v1/${settings.projectsTable}?${params}`, {
    method: "POST",
    headers: {
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(record),
  });
  if (!rows[0]) throw new Error("Supabase non ha restituito il record remoto aggiornato.");
  return rows[0];
}

async function insertEventRows(settings: SupabaseSyncSettings, rows: SupabaseEventRow[]): Promise<void> {
  if (rows.length === 0) return;
  await requestSupabase(settings, `/rest/v1/${settings.eventsTable}`, {
    method: "POST",
    headers: {
      Prefer: "return=minimal",
    },
    body: JSON.stringify(rows),
  });
}

async function loadRemoteState(
  settings: SupabaseSyncSettings,
  record: SupabaseProjectRecord
): Promise<{ seedProject: ProjectDocument; project: ProjectDocument; revision: string; syncedAt: number }> {
  const seedProject = await downloadSeedObject(settings, record.seed_object_path);
  const eventRows = await listEventRows(settings, record.id);
  const operations = normalizeProjectChangeOperations(eventRows.map((row) => row.operation)) ?? [];
  const latest = eventRows[eventRows.length - 1];
  return {
    seedProject,
    project: applyProjectOperations(seedProject, operations, latest?.saved_at ?? seedProject.savedAt),
    revision: latest?.batch_revision ?? record.latest_revision,
    syncedAt: latest ? Date.parse(latest.synced_at) : Date.parse(record.last_synced_at),
  };
}

async function listEventRows(settings: SupabaseSyncSettings, recordId: string): Promise<SupabaseEventRow[]> {
  const params = new URLSearchParams({
    select: "*",
    record_id: `eq.${recordId}`,
    order: "synced_at.asc,sequence_index.asc",
  });
  return requestSupabaseJson<SupabaseEventRow[]>(settings, `/rest/v1/${settings.eventsTable}?${params}`);
}

async function uploadSeedObject(
  settings: SupabaseSyncSettings,
  objectPath: string,
  project: ProjectDocument
): Promise<void> {
  await requestSupabase(settings, `/storage/v1/object/${encodePathSegment(settings.bucket)}/${encodeObjectPath(objectPath)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-upsert": "true",
    },
    body: JSON.stringify(project),
  });
}

async function downloadSeedObject(settings: SupabaseSyncSettings, objectPath: string): Promise<ProjectDocument> {
  // Use the policy-based path (not the `authenticated/` variant, which requires a Supabase Auth
  // session token).  The plain `/object/<bucket>/…` path honours the `Authorization` header and
  // evaluates storage RLS policies, so it works for both service-role and publishable/anon keys.
  const text = await requestSupabaseText(
    settings,
    `/storage/v1/object/${encodePathSegment(settings.bucket)}/${encodeObjectPath(objectPath)}`
  );
  const parsed = JSON.parse(text) as unknown;
  return toLocalProjectDocument(parsed);
}

async function requestSupabaseJson<T>(settings: SupabaseSyncSettings, path: string, init: RequestInit = {}): Promise<T> {
  const response = await requestSupabase(settings, path, init);
  return (await response.json()) as T;
}

async function requestSupabaseText(settings: SupabaseSyncSettings, path: string, init: RequestInit = {}): Promise<string> {
  const response = await requestSupabase(settings, path, init);
  return await response.text();
}

async function requestSupabase(settings: SupabaseSyncSettings, path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${settings.projectUrl}${path}`, {
    ...init,
    headers: {
      apikey: settings.accessKey,
      Authorization: `Bearer ${settings.accessKey}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    let message = `Supabase API error (${response.status})`;
    try {
      const payload = (await response.json()) as { message?: string; error?: string };
      message = payload.message || payload.error || message;
    } catch {
      /* noop */
    }
    throw new SupabaseApiError(message, response.status);
  }

  return response;
}

function buildSeedObjectPath(projectId: string): string {
  return `projects/${projectId}/seed.json`;
}

function buildSourceSeed(sourceUrl: string): string {
  const canonical = canonicalizeSourceUrl(sourceUrl);
  try {
    const url = new URL(canonical);
    const segments = url.pathname.split("/").filter(Boolean);
    return segments[segments.length - 1] || url.hostname;
  } catch {
    return canonical || "unknown-source";
  }
}

function toRemoteProjectDocument(project: ProjectDocument): ProjectDocument {
  return {
    ...cloneProjectDocument(project),
    sourceUrl: canonicalizeSourceUrl(project.sourceUrl),
    model: {
      ...project.model,
      baseHref: canonicalizeSourceUrl(project.model.baseHref || project.sourceUrl),
      originalHTML: "",
    },
  };
}

function toLocalProjectDocument(value: unknown): ProjectDocument {
  if (!value || typeof value !== "object") {
    throw new Error("The Supabase snapshot does not contain a valid project.");
  }

  const candidate = value as Partial<ProjectDocument> & {
    model?: Partial<ProjectDocument["model"]>;
  };

  if (
    typeof candidate.id !== "string" ||
    typeof candidate.title !== "string" ||
    typeof candidate.createdAt !== "number" ||
    typeof candidate.savedAt !== "number" ||
    !candidate.model ||
    !Array.isArray(candidate.model.macros)
  ) {
    throw new Error("The Supabase snapshot is incomplete.");
  }

  return {
    id: candidate.id,
    sourceUrl: canonicalizeSourceUrl(typeof candidate.sourceUrl === "string" ? candidate.sourceUrl : candidate.model.baseHref || ""),
    title: candidate.title,
    createdAt: candidate.createdAt,
    savedAt: candidate.savedAt,
    model: {
      preHTML: typeof candidate.model.preHTML === "string" ? candidate.model.preHTML : "",
      macros: candidate.model.macros as ProjectDocument["model"]["macros"],
      baseHref: canonicalizeSourceUrl(
        typeof candidate.model.baseHref === "string" ? candidate.model.baseHref : candidate.sourceUrl || ""
      ),
      originalHTML: typeof candidate.model.originalHTML === "string" ? candidate.model.originalHTML : "",
      header: {
        title: typeof candidate.model.header?.title === "string" ? candidate.model.header.title : candidate.title,
        meta: typeof candidate.model.header?.meta === "string" ? candidate.model.header.meta : "",
        heroImg: typeof candidate.model.header?.heroImg === "string" ? candidate.model.header.heroImg : "",
      },
    },
  };
}

function truncateTitle(value: string): string {
  return Array.from(value).slice(0, MAX_PROJECT_TITLE_LENGTH).join("");
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function encodeObjectPath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function createRevision(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `rev_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}
