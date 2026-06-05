import { useRef, useState } from "react";
import {
  Sparkles,
  Link as LinkIcon,
  Loader2,
  History,
  Trash2,
  LogOut,
  Plus,
  Upload,
} from "lucide-react";
import { formatRelative, type ProjectDocument } from "../lib/storage";
import { BrandLogo } from "./BrandLogo";

type Props = {
  username: string;
  savedProjects: ProjectDocument[];
  loading: boolean;
  initialURL: string;
  onLoadURL: (url: string) => void;
  onResume: (project: ProjectDocument) => void;
  onDelete: (project: ProjectDocument) => void;
  onImport: (file: File) => void;
  onLogout: () => void;
};

export function WelcomePage({
  username,
  savedProjects,
  loading,
  initialURL,
  onLoadURL,
  onResume,
  onDelete,
  onImport,
  onLogout,
}: Props) {
  const [url, setUrl] = useState(initialURL);
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="min-h-full flex flex-col bg-ink-900 text-ink-100">
      {/* Compact top bar */}
      <header className="px-6 py-3 border-b border-ink-600 bg-gradient-to-b from-ink-800 to-ink-900 flex items-center gap-4">
        <div className="flex items-center font-semibold">
          <BrandLogo variant="dark" className="h-9 w-auto" />
        </div>
        <div className="flex-1" />
        <span className="text-xs text-ink-300">
          Welcome back, <span className="text-ink-100 font-semibold capitalize">{username}</span>
        </span>
        <button
          onClick={onLogout}
          className="px-3 py-1.5 rounded-md border border-ink-600 hover:border-red-500 hover:text-red-400 text-xs flex items-center gap-1.5 transition"
          title="Sign out"
        >
          <LogOut size={12} /> Sign out
        </button>
      </header>

      <div className="flex-1 overflow-y-auto scroll-thin">
        <div className="max-w-5xl mx-auto px-6 py-12">
          <div className="text-center mb-12">
            <h1
              className="font-extralight tracking-tight leading-[1.05] mb-3 pb-[0.08em]"
              style={{
                fontSize: "clamp(32px, 5vw, 56px)",
                fontFamily: "sentient, serif",
                background: "linear-gradient(120deg, #ffffff 0%, #c4b8ff 45%, #5fffce 100%)",
                WebkitBackgroundClip: "text",
                backgroundClip: "text",
                WebkitTextFillColor: "transparent",
                letterSpacing: "-0.03em",
              }}
            >
              Where would you like to start?
            </h1>
            <p className="text-ink-300 text-sm">
              Start a new project from an AI Socratic URL, or continue a saved one.
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* Card: new project */}
            <div className="rounded-2xl border border-ink-600 bg-gradient-to-b from-ink-800 to-ink-900 p-6 flex flex-col">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-brand/15 border border-brand/30 flex items-center justify-center text-brand-400">
                  <Plus size={18} />
                </div>
                <div>
                  <h2 className="font-semibold text-ink-100">New project</h2>
                  <p className="text-[11px] text-ink-300">Start from an aisocratic.org blog post</p>
                </div>
              </div>

              <div className="space-y-3 flex-1 flex flex-col">
                <div className="relative">
                  <LinkIcon
                    size={14}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-300"
                  />
                  <input
                    type="url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && url.trim() && onLoadURL(url.trim())}
                    placeholder="https://aisocratic.org/blog/..."
                    className="w-full pl-9 pr-3 py-2.5 rounded-lg bg-ink-800 border border-ink-600 text-sm
                               focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/30"
                  />
                </div>
                <div className="text-[11px] text-ink-300">
                  Examples:{" "}
                  <button
                    onClick={() => setUrl("https://aisocratic.org/blog/ai-socratic-may-2026")}
                    className="text-brand-400 hover:underline"
                  >
                    May 2026
                  </button>
                  {" · "}
                  <button
                    onClick={() => setUrl("https://aisocratic.org/blog/ai-socratic-april-2026")}
                    className="text-brand-400 hover:underline"
                  >
                    April 2026
                  </button>
                </div>

                <div className="flex-1" />

                <button
                  onClick={() => url.trim() && onLoadURL(url.trim())}
                  disabled={loading || !url.trim()}
                  className="w-full py-2.5 rounded-lg bg-brand hover:brightness-110 text-white text-sm font-semibold flex items-center justify-center gap-2 transition disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {loading ? (
                    <Loader2 size={15} className="animate-spin" />
                  ) : (
                    <Sparkles size={15} />
                  )}
                  {loading ? "Loading…" : "Start"}
                </button>

                <div className="relative flex items-center gap-3 my-1">
                  <div className="flex-1 h-px bg-ink-600" />
                  <span className="text-[10px] uppercase tracking-widest font-bold text-ink-300">or</span>
                  <div className="flex-1 h-px bg-ink-600" />
                </div>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onImport(f);
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={loading}
                  className="w-full py-2.5 rounded-lg border border-dashed border-ink-600 hover:border-brand hover:text-brand-400
                             text-ink-300 text-sm font-medium flex items-center justify-center gap-2 transition
                             disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Import a .json file exported from another device"
                >
                  <Upload size={14} /> Import project from JSON
                </button>
              </div>
            </div>

            {/* Card: resume project */}
            <div className="rounded-2xl border border-ink-600 bg-gradient-to-b from-ink-800 to-ink-900 p-6 flex flex-col">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-mint/15 border border-mint/30 flex items-center justify-center text-mint">
                  <History size={18} />
                </div>
                <div>
                  <h2 className="font-semibold text-ink-100">Saved projects</h2>
                  <p className="text-[11px] text-ink-300">
                    {savedProjects.length === 0
                      ? "No saved projects yet"
                      : `${savedProjects.length} ${savedProjects.length === 1 ? "project available" : "projects available"}`}
                  </p>
                </div>
              </div>

              {savedProjects.length === 0 ? (
                <div className="flex-1 flex items-center justify-center text-center text-ink-300 text-xs italic border border-dashed border-ink-600 rounded-lg p-8">
                  Projects are saved automatically in your browser on this device after the first edit.
                </div>
              ) : (
                <div className="flex flex-col gap-2 max-h-[360px] overflow-y-auto scroll-thin pr-1">
                  {savedProjects.map((p) => (
                    <div
                      key={p.id}
                      className="group flex items-center gap-3 rounded-lg border border-ink-600
                                 bg-ink-800 hover:bg-ink-700 hover:border-brand/60 transition px-3 py-2.5"
                    >
                      <div
                        onClick={() => onResume(p)}
                        className="flex-1 min-w-0 cursor-pointer"
                      >
                        <div className="font-medium text-sm text-ink-100 truncate">{p.title}</div>
                        <div className="text-[11px] text-ink-300 truncate flex items-center gap-2">
                          <span>{formatRelative(p.savedAt)}</span>
                          <span className="opacity-60">·</span>
                          <code className="text-brand-400 truncate">{p.sourceUrl}</code>
                        </div>
                      </div>
                      <button
                        onClick={() => onResume(p)}
                        className="text-[11px] px-2.5 py-1 rounded bg-brand hover:brightness-110 text-white font-semibold whitespace-nowrap"
                      >
                        Resume
                      </button>
                      <button
                        onClick={() => onDelete(p)}
                        className="w-7 h-7 rounded border border-ink-600 hover:border-red-500 hover:text-red-400 flex items-center justify-center opacity-0 group-hover:opacity-100 transition"
                        title="Delete saved project"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
