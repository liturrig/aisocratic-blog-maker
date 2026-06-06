import {
  DEFAULT_GITHUB_OWNER,
  DEFAULT_GITHUB_REPO,
  DEFAULT_GITHUB_SYNC_LABEL,
  GitHubSyncConflictError,
  buildGitHubIssueUrl,
  loadGitHubSyncSettings,
  refreshProjectFromGitHub,
  saveGitHubSyncSettings,
  syncProjectToGitHub,
  type GitHubSyncSettings,
} from "./githubSync";
import {
  DEFAULT_SUPABASE_EVENTS_TABLE,
  DEFAULT_SUPABASE_OBJECT_BUCKET,
  DEFAULT_SUPABASE_PROJECTS_TABLE,
  SupabaseSyncConflictError,
  loadSupabaseSyncSettings,
  refreshProjectFromSupabase,
  saveSupabaseSyncSettings,
  syncProjectToSupabase,
  type SupabaseSyncSettings,
} from "./supabaseSync";
import type { ProjectSnapshot } from "./storage";

export type RemoteStorageProvider = "github" | "supabase";

export type RemoteStorageSettings = {
  provider: RemoteStorageProvider;
  accessKey: string;
  endpointUrl: string;
};

export class RemoteStorageConflictError extends Error {
  declare cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "RemoteStorageConflictError";
    if (cause !== undefined) this.cause = cause;
  }
}

export function loadRemoteStorageSettings(): RemoteStorageSettings {
  const provider = loadStoredProvider();
  return provider === "supabase" ? loadSupabaseRemoteSettings() : loadGitHubRemoteSettings();
}

export function selectRemoteStorageProvider(provider: RemoteStorageProvider): RemoteStorageSettings {
  persistRemoteProvider(provider);
  return provider === "supabase" ? loadSupabaseRemoteSettings() : loadGitHubRemoteSettings();
}

export function saveRemoteStorageSettings(settings: RemoteStorageSettings): RemoteStorageSettings {
  persistRemoteProvider(settings.provider);
  if (settings.provider === "supabase") {
    const current = loadSupabaseSyncSettings();
    const normalized = saveSupabaseSyncSettings({
      ...current,
      projectUrl: settings.endpointUrl,
      accessKey: settings.accessKey,
    });
    return toSupabaseRemoteSettings(normalized);
  }

  const current = loadGitHubSyncSettings();
  const normalized = saveGitHubSyncSettings({
    ...current,
    token: settings.accessKey,
  });
  return toGitHubRemoteSettings(normalized);
}

export function isRemoteStorageReady(settings: RemoteStorageSettings): boolean {
  return settings.provider === "supabase"
    ? Boolean(settings.endpointUrl.trim() && settings.accessKey.trim())
    : Boolean(settings.accessKey.trim());
}

export function buildRemoteRecordUrl(settings: RemoteStorageSettings, remoteId?: string | null): string | null {
  if (settings.provider === "supabase") return null;
  return buildGitHubIssueUrl(toGitHubProviderSettings(settings), remoteId);
}

export async function syncProjectToRemote(settings: RemoteStorageSettings, userId: string, snapshot: ProjectSnapshot) {
  try {
    return settings.provider === "supabase"
      ? await syncProjectToSupabase(toSupabaseProviderSettings(settings), userId, snapshot)
      : await syncProjectToGitHub(toGitHubProviderSettings(settings), userId, snapshot);
  } catch (error) {
    throw normalizeRemoteError(error);
  }
}

export async function refreshProjectFromRemote(
  settings: RemoteStorageSettings,
  userId: string,
  projectId: string,
  sourceUrl: string,
  remoteId?: string | null
) {
  try {
    return settings.provider === "supabase"
      ? await refreshProjectFromSupabase(toSupabaseProviderSettings(settings), userId, projectId, sourceUrl, remoteId)
      : await refreshProjectFromGitHub(toGitHubProviderSettings(settings), userId, projectId, sourceUrl, remoteId);
  } catch (error) {
    throw normalizeRemoteError(error);
  }
}

const PROVIDER_STORAGE_KEY = "aisocratic:remote-storage-provider";

function loadStoredProvider(): RemoteStorageProvider {
  try {
    const stored = localStorage.getItem(PROVIDER_STORAGE_KEY);
    if (stored === "github" || stored === "supabase") return stored;
  } catch {
    /* noop */
  }
  return "supabase";
}

function persistRemoteProvider(provider: RemoteStorageProvider): void {
  try {
    localStorage.setItem(PROVIDER_STORAGE_KEY, provider);
  } catch {
    /* noop */
  }
}

function loadGitHubRemoteSettings(): RemoteStorageSettings {
  return toGitHubRemoteSettings(loadGitHubSyncSettings());
}

function toGitHubRemoteSettings(settings: GitHubSyncSettings): RemoteStorageSettings {
  return {
    provider: "github",
    accessKey: settings.token,
    endpointUrl: "",
  };
}

function toGitHubProviderSettings(settings: RemoteStorageSettings): GitHubSyncSettings {
  const current = loadGitHubSyncSettings();
  return {
    owner: current.owner || DEFAULT_GITHUB_OWNER,
    repo: current.repo || DEFAULT_GITHUB_REPO,
    label: current.label || DEFAULT_GITHUB_SYNC_LABEL,
    token: settings.accessKey.trim(),
  };
}

function loadSupabaseRemoteSettings(): RemoteStorageSettings {
  return toSupabaseRemoteSettings(loadSupabaseSyncSettings());
}

function toSupabaseRemoteSettings(settings: SupabaseSyncSettings): RemoteStorageSettings {
  return {
    provider: "supabase",
    accessKey: settings.accessKey,
    endpointUrl: settings.projectUrl,
  };
}

function toSupabaseProviderSettings(settings: RemoteStorageSettings): SupabaseSyncSettings {
  const current = loadSupabaseSyncSettings();
  return {
    projectUrl: settings.endpointUrl,
    accessKey: settings.accessKey,
    bucket: current.bucket || DEFAULT_SUPABASE_OBJECT_BUCKET,
    projectsTable: current.projectsTable || DEFAULT_SUPABASE_PROJECTS_TABLE,
    eventsTable: current.eventsTable || DEFAULT_SUPABASE_EVENTS_TABLE,
  };
}

function normalizeRemoteError(error: unknown): Error {
  if (error instanceof RemoteStorageConflictError) return error;
  if (error instanceof GitHubSyncConflictError || error instanceof SupabaseSyncConflictError) {
    return new RemoteStorageConflictError(error.message, error);
  }
  return error instanceof Error ? error : new Error(String(error));
}
