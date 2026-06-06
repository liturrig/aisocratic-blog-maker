import {
  applyProjectOperations,
  canonicalizeSourceUrl,
  cloneProjectDocument,
  normalizeProjectChangeOperations,
  type ProjectChangeOperation,
  type ProjectDocument,
  type ProjectSnapshot,
  type ProjectSyncState,
} from "./storage";

const SETTINGS_STORAGE_KEY = "aisocratic:github-sync-settings";
const TOKEN_STORAGE_KEY = "aisocratic:github-sync-token";
const MAX_ISSUE_TITLE_LENGTH = 240;
const MAX_GITHUB_LABEL_VALUE_LENGTH = 40;
const GITHUB_LABEL_HASH_LENGTH = 6;
const PRIMARY_LABEL_COLOR = "7c5cff";
const SCOPE_LABEL_COLOR = "5fffce";
const PRIMARY_LABEL_DESCRIPTION = "Canonical AI Socratic project snapshots";
const SCOPE_LABEL_DESCRIPTION = "Scoped AI Socratic sync label";
const MAX_REMOTE_EVENT_COMMENT_PAGES = 10;
const SNAPSHOT_FORMAT_V1 = "aisocratic-github-sync-v1";
const SNAPSHOT_FORMAT_V2 = "aisocratic-github-sync-v2";
const EVENT_FORMAT_V1 = "aisocratic-sync-event-v1";

export const DEFAULT_GITHUB_OWNER = "liturrig";
export const DEFAULT_GITHUB_REPO = "ai-aperitivo-blog-maker";
export const DEFAULT_GITHUB_SYNC_LABEL = "aisocratic-project-sync";

type PersistedGitHubSyncSettings = Partial<Pick<GitHubSyncSettings, "owner" | "repo" | "label">>;

type GitHubIssue = {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  updated_at: string;
  pull_request?: unknown;
};

type GitHubSearchResponse = {
  items: GitHubIssue[];
};

type GitHubIssueComment = {
  id: number;
  body: string | null;
  created_at: string;
  updated_at: string;
};

type IssueFrontmatter = {
  format: string;
  projectId: string;
  sourceUrl: string;
  sourceSeed: string;
  revision: string;
  savedAt: number;
  syncedAt: number;
  userId: string;
};

type GitHubRemoteProject = {
  issueNumber: number;
  issueUrl: string;
  snapshot: ProjectSnapshot;
  foundExisting: boolean;
};

type RemoteCommentEvent = {
  format: typeof EVENT_FORMAT_V1;
  projectId: string;
  revision: string;
  previousRevision: string | null;
  savedAt: number;
  syncedAt: number;
  userId: string;
  operations: ProjectChangeOperation[];
};

export type GitHubSyncSettings = {
  owner: string;
  repo: string;
  token: string;
  label: string;
};

export class GitHubSyncConflictError extends Error {
  readonly remote: GitHubRemoteProject;

  constructor(message: string, remote: GitHubRemoteProject) {
    super(message);
    this.name = "GitHubSyncConflictError";
    this.remote = remote;
  }
}

class GitHubSyncConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubSyncConfigurationError";
  }
}

class GitHubApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
  }
}

export function loadGitHubSyncSettings(): GitHubSyncSettings {
  let persisted: PersistedGitHubSyncSettings = {};
  let token = "";

  if (typeof localStorage !== "undefined") {
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (raw) persisted = JSON.parse(raw) as PersistedGitHubSyncSettings;
    } catch {
      /* noop */
    }
  }

  if (typeof sessionStorage !== "undefined") {
    try {
      token = sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
    } catch {
      /* noop */
    }
  }

  return {
    owner: typeof persisted.owner === "string" ? persisted.owner.trim() : DEFAULT_GITHUB_OWNER,
    repo: typeof persisted.repo === "string" ? persisted.repo.trim() : DEFAULT_GITHUB_REPO,
    label: typeof persisted.label === "string" && persisted.label.trim() ? persisted.label.trim() : DEFAULT_GITHUB_SYNC_LABEL,
    token: token.trim(),
  };
}

export function saveGitHubSyncSettings(settings: GitHubSyncSettings): GitHubSyncSettings {
  const normalized = normalizeGitHubSyncSettings(settings);

  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(
        SETTINGS_STORAGE_KEY,
        JSON.stringify({
          owner: normalized.owner,
          repo: normalized.repo,
          label: normalized.label,
        })
      );
    } catch {
      /* noop */
    }
  }

  if (typeof sessionStorage !== "undefined") {
    try {
      if (normalized.token) sessionStorage.setItem(TOKEN_STORAGE_KEY, normalized.token);
      else sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch {
      /* noop */
    }
  }

  return normalized;
}

export function isGitHubSyncConfigured(settings: GitHubSyncSettings): boolean {
  return Boolean(settings.owner && settings.repo && settings.token);
}

export function buildGitHubIssueUrl(settings: Pick<GitHubSyncSettings, "owner" | "repo">, remoteId?: string | null): string | null {
  if (!settings.owner || !settings.repo || !remoteId) return null;
  return `https://github.com/${settings.owner}/${settings.repo}/issues/${remoteId}`;
}

export async function syncProjectToGitHub(
  settings: GitHubSyncSettings,
  userId: string,
  snapshot: ProjectSnapshot
): Promise<GitHubRemoteProject> {
  const normalizedSettings = requireGitHubSyncSettings(settings);

  const localProject = snapshot.project;
  const localSeedProject = snapshot.syncState?.seedProject ?? localProject;
  const pendingOperations = snapshot.syncState?.pendingOperations ?? [];
  const scope = buildRemoteScope(normalizedSettings.label, userId, localProject.sourceUrl);
  await ensureSyncLabelsExist(normalizedSettings, scope.labels);
  const existingIssue = await resolveProjectIssue(
    normalizedSettings,
    localProject.id,
    localProject.sourceUrl,
    userId,
    snapshot.syncState?.remoteId ?? null
  );
  const parsedRemote = existingIssue ? parseRemoteIssue(existingIssue) : null;
  const remoteEvents = existingIssue ? await listRemoteEvents(normalizedSettings, existingIssue.number) : [];
  const remoteState = parsedRemote ? buildRemoteProjectState(parsedRemote, remoteEvents) : null;
  const seedProject = toRemoteProjectDocument(remoteState?.seedProject ?? localSeedProject);

  if (existingIssue && remoteState && remoteState.revision !== (snapshot.syncState?.revision ?? null)) {
    throw new GitHubSyncConflictError(
      "The remote GitHub revision changed. Refresh the project from GitHub before syncing again.",
      toRemoteProject(existingIssue, remoteState.project, remoteState.revision, remoteState.syncedAt, remoteState.seedProject, true)
    );
  }

  const syncedAt = Date.now();
  const revision = pendingOperations.length > 0 || !existingIssue ? createRevision() : snapshot.syncState?.revision ?? createRevision();
  const issueBody = serializeIssueBody(seedProject, {
    format: SNAPSHOT_FORMAT_V2,
    projectId: localProject.id,
    sourceUrl: canonicalizeSourceUrl(seedProject.sourceUrl),
    sourceSeed: scope.sourceSeed,
    revision,
    savedAt: seedProject.savedAt,
    syncedAt,
    userId,
  });

  const shouldUpdateIssueBody =
    !parsedRemote || !sameProjectDocument(parsedRemote.project, seedProject);
  const issue = existingIssue
    ? await requestGitHub<GitHubIssue>(normalizedSettings, issuePath(normalizedSettings, existingIssue.number), {
        method: "PATCH",
        body: JSON.stringify({
          title: buildIssueTitle(localProject),
          ...(shouldUpdateIssueBody ? { body: issueBody } : {}),
          labels: scope.labels,
        }),
      })
    : await requestGitHub<GitHubIssue>(normalizedSettings, repoPath(normalizedSettings, "/issues"), {
        method: "POST",
        body: JSON.stringify({
          title: buildIssueTitle(localProject),
          body: issueBody,
          labels: scope.labels,
        }),
      });

  if (pendingOperations.length > 0) {
    await createEventComment(
      normalizedSettings,
      issue.number,
      {
        format: EVENT_FORMAT_V1,
        projectId: localProject.id,
        revision,
        previousRevision: remoteState?.revision ?? snapshot.syncState?.revision ?? null,
        savedAt: localProject.savedAt,
        syncedAt,
        userId,
        operations: pendingOperations,
      }
    );
  }

  const syncState: ProjectSyncState = {
    remoteId: String(issue.number),
    revision,
    lastSyncedAt: syncedAt,
    seedProject: cloneProjectDocument(remoteState?.seedProject ?? localSeedProject),
    pendingOperations: [],
  };

  return {
    issueNumber: issue.number,
    issueUrl: issue.html_url,
    foundExisting: Boolean(existingIssue),
    snapshot: {
      project: localProject,
      syncState,
    },
  };
}

export async function refreshProjectFromGitHub(
  settings: GitHubSyncSettings,
  userId: string,
  projectId: string,
  sourceUrl: string,
  remoteId?: string | null
): Promise<GitHubRemoteProject> {
  const normalizedSettings = requireGitHubSyncSettings(settings);
  const issue = await resolveProjectIssue(normalizedSettings, projectId, sourceUrl, userId, remoteId ?? null);
  if (!issue) {
    throw new Error("No GitHub issue found for this project.");
  }

  const parsedRemote = parseRemoteIssue(issue);
  if (parsedRemote.frontmatter.projectId !== projectId) {
    throw new Error("The configured GitHub issue belongs to a different project.");
  }

  const remoteEvents = await listRemoteEvents(normalizedSettings, issue.number);
  const remoteState = buildRemoteProjectState(parsedRemote, remoteEvents);
  return toRemoteProject(issue, remoteState.project, remoteState.revision, remoteState.syncedAt, remoteState.seedProject, true);
}

function normalizeGitHubSyncSettings(settings: GitHubSyncSettings): GitHubSyncSettings {
  return {
    owner: settings.owner.trim(),
    repo: settings.repo.trim(),
    token: settings.token.trim(),
    label: settings.label.trim() || DEFAULT_GITHUB_SYNC_LABEL,
  };
}

function requireGitHubSyncSettings(settings: GitHubSyncSettings): GitHubSyncSettings {
  const normalized = normalizeGitHubSyncSettings(settings);
  if (!normalized.owner || !normalized.repo || !normalized.token) {
    throw new GitHubSyncConfigurationError("Configure the GitHub owner, repository, and token before using remote sync.");
  }
  return normalized;
}

async function ensureSyncLabelsExist(settings: GitHubSyncSettings, labels: string[]): Promise<void> {
  for (const label of labels) {
    await ensureSyncLabelExists(settings, label);
  }
}

async function resolveProjectIssue(
  settings: GitHubSyncSettings,
  projectId: string,
  sourceUrl: string,
  userId: string,
  remoteId: string | null
): Promise<GitHubIssue | null> {
  if (remoteId) {
    const direct = await loadIssueByRemoteId(settings, remoteId);
    if (direct) return direct;
  }
  return findIssueByProjectId(settings, projectId, sourceUrl, userId);
}

async function loadIssueByRemoteId(settings: GitHubSyncSettings, remoteId: string): Promise<GitHubIssue | null> {
  const issueNumber = Number(remoteId);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return null;
  try {
    const issue = await requestGitHub<GitHubIssue>(settings, issuePath(settings, issueNumber));
    return issue.pull_request ? null : issue;
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return null;
    throw error;
  }
}

async function findIssueByProjectId(
  settings: GitHubSyncSettings,
  projectId: string,
  sourceUrl: string,
  userId: string
): Promise<GitHubIssue | null> {
  const scope = buildRemoteScope(settings.label, userId, sourceUrl);
  const query = encodeURIComponent(
    `repo:${settings.owner}/${settings.repo} is:issue ${scope.labels.map((label) => `label:"${label}"`).join(" ")} in:title "[aisocratic:${projectId}]"`
  );
  const response = await requestGitHub<GitHubSearchResponse>(settings, `/search/issues?q=${query}&per_page=10`);
  for (const item of response.items) {
    if (item.pull_request) continue;
    try {
      const parsed = parseRemoteIssue(item);
      if (parsed.frontmatter.projectId === projectId) return item;
    } catch {
      /* skip malformed issue bodies */
    }
  }
  return null;
}

async function createEventComment(
  settings: GitHubSyncSettings,
  issueNumber: number,
  event: RemoteCommentEvent
): Promise<void> {
  await requestGitHub(settings, issuePath(settings, issueNumber, "/comments"), {
    method: "POST",
    body: JSON.stringify({
      body: serializeEventComment(event),
    }),
  });
}

async function requestGitHub<T>(
  settings: GitHubSyncSettings,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${settings.token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    let message = `GitHub API error (${response.status})`;
    try {
      const payload = (await response.json()) as { message?: string };
      if (payload.message) message = payload.message;
    } catch {
      /* noop */
    }
    throw new GitHubApiError(message, response.status);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function listRemoteEvents(settings: GitHubSyncSettings, issueNumber: number): Promise<RemoteCommentEvent[]> {
  const events: RemoteCommentEvent[] = [];
  for (let page = 1; page <= MAX_REMOTE_EVENT_COMMENT_PAGES; page += 1) {
    const comments = await requestGitHub<GitHubIssueComment[]>(
      settings,
      `${issuePath(settings, issueNumber, "/comments")}?per_page=100&page=${page}`
    );
    for (const comment of comments) {
      const event = parseEventComment(comment.body ?? "");
      if (event) events.push(event);
    }
    if (comments.length < 100) break;
  }
  return events;
}

function buildRemoteProjectState(
  parsedRemote: { frontmatter: IssueFrontmatter; project: ProjectDocument },
  events: RemoteCommentEvent[]
): { seedProject: ProjectDocument; project: ProjectDocument; revision: string; syncedAt: number } {
  const seedProject = cloneProjectDocument(parsedRemote.project);
  if (events.length === 0) {
    return {
      seedProject,
      project: cloneProjectDocument(parsedRemote.project),
      revision: parsedRemote.frontmatter.revision,
      syncedAt: parsedRemote.frontmatter.syncedAt,
    };
  }
  const operations = events.flatMap((event) => event.operations);
  const latest = events[events.length - 1];
  return {
    seedProject,
    project: applyProjectOperations(seedProject, operations, latest.savedAt),
    revision: latest.revision,
    syncedAt: latest.syncedAt,
  };
}

function serializeEventComment(event: RemoteCommentEvent): string {
  return [
    `<!-- ${EVENT_FORMAT_V1} -->`,
    `Revisione: \`${event.revision}\``,
    "",
    "```json",
    JSON.stringify(event, null, 2),
    "```",
  ].join("\n");
}

function parseEventComment(body: string): RemoteCommentEvent | null {
  if (!body.includes(EVENT_FORMAT_V1)) return null;
  const match = body.match(/```json\n([\s\S]*?)\n```/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as Record<string, unknown>;
    if (
      parsed.format !== EVENT_FORMAT_V1 ||
      typeof parsed.projectId !== "string" ||
      typeof parsed.revision !== "string" ||
      !Array.isArray(parsed.operations)
    ) {
      return null;
    }
    return {
      format: EVENT_FORMAT_V1,
      projectId: parsed.projectId,
      revision: parsed.revision,
      previousRevision: typeof parsed.previousRevision === "string" ? parsed.previousRevision : null,
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : Date.now(),
      syncedAt: typeof parsed.syncedAt === "number" ? parsed.syncedAt : Date.now(),
      userId: typeof parsed.userId === "string" ? parsed.userId : "",
      operations: normalizeProjectChangeOperations(parsed.operations) ?? [],
    };
  } catch {
    return null;
  }
}

function parseRemoteIssue(issue: GitHubIssue): { frontmatter: IssueFrontmatter; project: ProjectDocument } {
  const body = issue.body ?? "";
  const match = body.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    throw new Error("The GitHub issue body does not contain valid frontmatter.");
  }

  const frontmatter = parseFrontmatter(match[1]);
  if (
    ![SNAPSHOT_FORMAT_V1, SNAPSHOT_FORMAT_V2].includes(frontmatter.format) ||
    typeof frontmatter.projectId !== "string" ||
    typeof frontmatter.sourceUrl !== "string" ||
    typeof frontmatter.sourceSeed !== "string" ||
    typeof frontmatter.revision !== "string" ||
    typeof frontmatter.savedAt !== "number" ||
    typeof frontmatter.syncedAt !== "number" ||
    typeof frontmatter.userId !== "string"
  ) {
    throw new Error("The GitHub issue frontmatter is invalid.");
  }

  const jsonMatch = match[2].match(/```json\n([\s\S]*?)\n```/);
  if (!jsonMatch) {
    throw new Error("The GitHub issue body does not contain a valid JSON snapshot.");
  }

  const parsed = JSON.parse(jsonMatch[1]) as unknown;
  return {
    frontmatter,
    project: toLocalProjectDocument(parsed, frontmatter),
  };
}

function parseFrontmatter(frontmatterBlock: string): IssueFrontmatter {
  const out: Record<string, unknown> = {};
  for (const line of frontmatterBlock.split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    try {
      out[key] = JSON.parse(rawValue);
    } catch {
      out[key] = rawValue;
    }
  }
  return out as IssueFrontmatter;
}

function serializeIssueBody(project: ProjectDocument, frontmatter: IssueFrontmatter): string {
  return `---
${serializeFrontmatter(frontmatter)}---
# AI Socratic project seed

This issue stores the source snapshot for one browser project. Incremental remote history is serialized in issue comments.

- Project title: ${project.title || project.sourceUrl}
- Source URL: ${project.sourceUrl}
- Seed revision: \`${frontmatter.revision}\`
- Seed stored at: ${new Date(frontmatter.syncedAt).toISOString()}

## Seed JSON

\`\`\`json
${JSON.stringify(project, null, 2)}
\`\`\`
`;
}

function serializeFrontmatter(frontmatter: IssueFrontmatter): string {
  return Object.entries(frontmatter)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n")
    .concat("\n");
}

function toRemoteProjectDocument(project: ProjectDocument): ProjectDocument {
  return {
    ...project,
    sourceUrl: canonicalizeSourceUrl(project.sourceUrl),
    model: {
      ...project.model,
      baseHref: canonicalizeSourceUrl(project.model.baseHref || project.sourceUrl),
      originalHTML: "",
    },
  };
}

function toLocalProjectDocument(value: unknown, frontmatter: IssueFrontmatter): ProjectDocument {
  if (!value || typeof value !== "object") {
    throw new Error("The GitHub snapshot does not contain a valid project.");
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
    throw new Error("The GitHub snapshot is incomplete.");
  }

  return {
    id: candidate.id,
    sourceUrl: canonicalizeSourceUrl(
      typeof candidate.sourceUrl === "string" ? candidate.sourceUrl : frontmatter.sourceUrl
    ),
    title: candidate.title,
    createdAt: candidate.createdAt,
    savedAt: candidate.savedAt,
    model: {
      preHTML: typeof candidate.model.preHTML === "string" ? candidate.model.preHTML : "",
      macros: candidate.model.macros as ProjectDocument["model"]["macros"],
      baseHref: canonicalizeSourceUrl(
        typeof candidate.model.baseHref === "string" ? candidate.model.baseHref : frontmatter.sourceUrl
      ),
      originalHTML: typeof candidate.model.originalHTML === "string" ? candidate.model.originalHTML : "",
      header: {
        title:
          typeof candidate.model.header?.title === "string" ? candidate.model.header.title : candidate.title,
        meta: typeof candidate.model.header?.meta === "string" ? candidate.model.header.meta : "",
        heroImg: typeof candidate.model.header?.heroImg === "string" ? candidate.model.header.heroImg : "",
      },
    },
  };
}

function toRemoteProject(
  issue: GitHubIssue,
  project: ProjectDocument,
  revision: string,
  syncedAt: number,
  seedProject: ProjectDocument,
  foundExisting: boolean
): GitHubRemoteProject {
  return {
    issueNumber: issue.number,
    issueUrl: issue.html_url,
    foundExisting,
    snapshot: {
      project,
      syncState: {
        remoteId: String(issue.number),
        revision,
        lastSyncedAt: syncedAt,
        seedProject: cloneProjectDocument(seedProject),
        pendingOperations: [],
      },
    },
  };
}

function buildIssueTitle(project: ProjectDocument): string {
  const title = project.title || project.sourceUrl || "Untitled project";
  return truncateForIssueTitle(`[aisocratic:${project.id}] ${title}`, MAX_ISSUE_TITLE_LENGTH);
}

function createRevision(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `rev_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function repoPath(settings: Pick<GitHubSyncSettings, "owner" | "repo">, suffix = ""): string {
  return `/repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}${suffix}`;
}

function issuePath(settings: Pick<GitHubSyncSettings, "owner" | "repo">, issueNumber: number, suffix = ""): string {
  return `${repoPath(settings, "/issues")}/${issueNumber}${suffix}`;
}

function truncateForIssueTitle(value: string, maxLength: number): string {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    const segments = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value));
    return segments.slice(0, maxLength).map((item) => item.segment).join("");
  }
  return Array.from(value)
    .slice(0, maxLength)
    .join("");
}

async function ensureSyncLabelExists(settings: GitHubSyncSettings, label: string): Promise<void> {
  try {
    await requestGitHub(settings, repoPath(settings, `/labels/${encodeURIComponent(label)}`));
  } catch (error) {
    if (!(error instanceof GitHubApiError)) {
      throw new Error(`Unable to verify the GitHub label "${label}".`, { cause: error });
    }
    if (error.status !== 404) {
      throw new Error(`Unable to verify the GitHub label "${label}": ${error.message}`, {
        cause: error,
      });
    }
    try {
      await requestGitHub(settings, repoPath(settings, "/labels"), {
        method: "POST",
        body: JSON.stringify({
          name: label,
          color: label === settings.label ? PRIMARY_LABEL_COLOR : SCOPE_LABEL_COLOR,
          description: label === settings.label ? PRIMARY_LABEL_DESCRIPTION : SCOPE_LABEL_DESCRIPTION,
        }),
      });
    } catch (createError) {
      const message = createError instanceof Error ? createError.message : String(createError);
      throw new Error(`Unable to create the GitHub label "${label}": ${message}`, {
        cause: createError,
      });
    }
  }
}

function buildRemoteScope(baseLabel: string, userId: string, sourceUrl: string) {
  const sourceSeed = buildSourceSeed(sourceUrl);
  return {
    sourceSeed,
    labels: [baseLabel, `aisocratic-user:${normalizeLabelValue(userId)}`, `aisocratic-source:${normalizeLabelValue(sourceSeed)}`],
  };
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

/** Normalizes dynamic scope values into GitHub-label-safe slugs.
 *  When truncation is needed, keeps a readable prefix plus a fixed-width hash suffix
 *  so long values remain stable and are less likely to collide. */
function normalizeLabelValue(value: string): string {
  const compact = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!compact) return "unknown";
  if (compact.length <= MAX_GITHUB_LABEL_VALUE_LENGTH) return compact;
  const hash = hashLabelValue(compact);
  const prefixLength = Math.max(1, MAX_GITHUB_LABEL_VALUE_LENGTH - GITHUB_LABEL_HASH_LENGTH - 1);
  return `${compact.slice(0, prefixLength)}-${hash}`;
}

/** Small fixed-width FNV-1a hash used only to disambiguate truncated label values. */
function hashLabelValue(value: string): string {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0)
    .toString(36)
    .padStart(GITHUB_LABEL_HASH_LENGTH, "0")
    .slice(-GITHUB_LABEL_HASH_LENGTH);
}

function sameProjectDocument(left: ProjectDocument, right: ProjectDocument): boolean {
  return (
    left.id === right.id &&
    left.sourceUrl === right.sourceUrl &&
    left.title === right.title &&
    left.createdAt === right.createdAt &&
    left.savedAt === right.savedAt &&
    left.model.preHTML === right.model.preHTML &&
    left.model.baseHref === right.model.baseHref &&
    left.model.originalHTML === right.model.originalHTML &&
    left.model.header.title === right.model.header.title &&
    left.model.header.meta === right.model.header.meta &&
    left.model.header.heroImg === right.model.header.heroImg &&
    sameMacros(left.model.macros, right.model.macros)
  );
}

function sameMacros(left: ProjectDocument["model"]["macros"], right: ProjectDocument["model"]["macros"]): boolean {
  return (
    left.length === right.length &&
    left.every((macro, index) => {
      const candidate = right[index];
      return (
        macro.id === candidate.id &&
        macro.title === candidate.title &&
        macro.headingHTML === candidate.headingHTML &&
        macro.introHTML === candidate.introHTML &&
        macro.custom === candidate.custom &&
        sameItems(macro.items, candidate.items)
      );
    })
  );
}

function sameItems(left: ProjectDocument["model"]["macros"][number]["items"], right: ProjectDocument["model"]["macros"][number]["items"]): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => {
      const candidate = right[index];
      return (
        item.id === candidate.id &&
        item.title === candidate.title &&
        item.level === candidate.level &&
        item.headingHTML === candidate.headingHTML &&
        item.bodyHTML === candidate.bodyHTML &&
        item.imageUrl === candidate.imageUrl &&
        item.snippet === candidate.snippet &&
        item.columnsGroupId === candidate.columnsGroupId &&
        item.custom === candidate.custom
      );
    })
  );
}
