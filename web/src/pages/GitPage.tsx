import { useCallback, useEffect, useRef, useState } from "react";
import {
  GitBranch as GitBranchIcon,
  GitPullRequest,
  RefreshCw,
  Plus,
  Trash2,
  Undo2,
  Upload,
  ExternalLink,
} from "lucide-react";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import { Card, CardContent } from "@nous-research/ui/ui/components/card";
import { Input } from "@nous-research/ui/ui/components/input";
import { Segmented } from "@nous-research/ui/ui/components/segmented";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { Switch } from "@nous-research/ui/ui/components/switch";
import { Toast } from "@nous-research/ui/ui/components/toast";
import { useToast } from "@nous-research/ui/hooks/use-toast";

import { api } from "@/lib/api";
import type {
  GitBranch,
  GitReviewFile,
  GitReviewScope,
  GitShipInfo,
  GitStatus,
  GitWorktree,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { usePageHeader } from "@/contexts/usePageHeader";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { PluginSlot } from "@/plugins";

const SCOPES: { value: GitReviewScope; label: string }[] = [
  { value: "uncommitted", label: "Uncommitted" },
  { value: "branch", label: "vs branch base" },
  { value: "lastTurn", label: "Last turn" },
];

/** Colour a unified-diff line by its leading marker. */
function diffLineClass(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return "text-success";
  if (line.startsWith("-") && !line.startsWith("---")) return "text-destructive";
  if (line.startsWith("@@")) return "text-primary";
  if (line.startsWith("diff ") || line.startsWith("index ")) return "text-text-tertiary";
  return "text-text-secondary";
}

export default function GitPage() {
  const { toast, showToast } = useToast();
  const { setEnd } = usePageHeader();

  const [repoPath, setRepoPath] = useState("");
  const [pathInput, setPathInput] = useState("");
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [notRepo, setNotRepo] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [scope, setScope] = useState<GitReviewScope>("uncommitted");
  const [files, setFiles] = useState<GitReviewFile[]>([]);
  const [selected, setSelected] = useState<GitReviewFile | null>(null);
  const [diff, setDiff] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);

  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  const [ship, setShip] = useState<GitShipInfo | null>(null);

  const [message, setMessage] = useState("");
  const [pushOnCommit, setPushOnCommit] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const [wtName, setWtName] = useState("");
  const [wtBase, setWtBase] = useState("");
  // Recent commit subjects, shown as writing hints (commit-context endpoint).
  const [recentSubjects, setRecentSubjects] = useState<string[]>([]);
  const recentHintPathRef = useRef("");
  const [confirmState, setConfirmState] = useState<
    | { kind: "revert"; file: string }
    | { kind: "removeWorktree"; path: string }
    | null
  >(null);

  // Seed the repo path from the server's default cwd → git root on first load.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { cwd } = await api.getGitDefaultCwd();
        const { root } = await api.getGitRoot(cwd);
        if (cancelled) return;
        const resolved = root || cwd;
        setRepoPath(resolved);
        setPathInput(resolved);
      } catch {
        /* leave empty — the user can type a path */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async (path: string, activeScope: GitReviewScope) => {
    if (!path) return;
    setLoading(true);
    setError(null);
    const [st, list, br, wt, sh] = await Promise.allSettled([
      api.getGitStatus(path),
      api.getGitReviewList(path, activeScope),
      api.getGitBranches(path),
      api.getGitWorktrees(path),
      api.getGitShipInfo(path),
    ]);
    if (st.status === "fulfilled") {
      setStatus(st.value);
      setNotRepo(st.value === null);
    } else {
      setError("Could not read the repository. Check the path.");
    }
    setFiles(list.status === "fulfilled" ? list.value.files : []);
    setBranches(br.status === "fulfilled" ? br.value.branches : []);
    setWorktrees(wt.status === "fulfilled" ? wt.value.worktrees : []);
    setShip(sh.status === "fulfilled" ? sh.value : null);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!repoPath) return;
    // Defer so the loader's setState isn't called synchronously in the effect.
    queueMicrotask(() => void refresh(repoPath, scope));
  }, [repoPath, scope, refresh]);


  const openDiff = useCallback(
    async (file: GitReviewFile) => {
      setSelected(file);
      setDiffLoading(true);
      setDiff("");
      try {
        const res = await api.getGitReviewDiff(repoPath, file.path, scope, file.staged);
        setDiff(res.diff || "No textual diff (binary or empty).");
      } catch {
        setDiff("Could not load the diff.");
      } finally {
        setDiffLoading(false);
      }
    },
    [repoPath, scope],
  );

  const run = useCallback(
    async (key: string, fn: () => Promise<unknown>, okMsg: string) => {
      setBusy(key);
      try {
        await fn();
        showToast(okMsg, "success");
        await refresh(repoPath, scope);
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Action failed.", "error");
      } finally {
        setBusy(null);
      }
    },
    [repoPath, scope, refresh, showToast],
  );

  useEffect(() => {
    setEnd(
      <Button
        ghost
        size="icon"
        onClick={() => void refresh(repoPath, scope)}
        disabled={loading || !repoPath}
        aria-label="Refresh git status"
      >
        {loading ? <Spinner /> : <RefreshCw />}
      </Button>,
    );
    return () => setEnd(null);
  }, [setEnd, refresh, repoPath, scope, loading]);

  const loadRecentHint = useCallback(async () => {
    if (recentHintPathRef.current === repoPath || !repoPath) return;
    recentHintPathRef.current = repoPath;
    try {
      const ctx = await api.getGitCommitContext(repoPath);
      setRecentSubjects(
        ctx.recent ? ctx.recent.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 5) : [],
      );
    } catch {
      /* ignore — hints are optional */
    }
  }, [repoPath]);

  const canCommit = status ? status.staged > 0 : false;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-1 sm:p-3">
      <PluginSlot name="git:top" />
      <p className="text-sm text-muted-foreground">
        Review changes, stage, commit, push and manage branches and worktrees —
        all against the repository on the server.
      </p>

      {/* Repo path + status */}
      <Card>
        <CardContent className="flex flex-col gap-3 py-4">
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setRepoPath(pathInput.trim());
            }}
          >
            <label className="min-w-0 flex-1">
              <span className="mb-1 block text-xs text-text-secondary">Repository path</span>
              <Input
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                placeholder="/path/to/repo"
                className="font-mono-ui text-xs"
              />
            </label>
            <Button type="submit" outlined disabled={!pathInput.trim()}>
              Open
            </Button>
          </form>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {notRepo && !error && (
            <p role="status" className="text-sm text-warning">
              That path is not a git repository.
            </p>
          )}
          {status && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone="secondary" className="gap-1">
                <GitBranchIcon className="h-3.5 w-3.5" />
                {status.detached ? "detached HEAD" : (status.branch ?? "—")}
              </Badge>
              {status.ahead > 0 && <Badge tone="outline">↑ {status.ahead} ahead</Badge>}
              {status.behind > 0 && <Badge tone="outline">↓ {status.behind} behind</Badge>}
              <span className="text-text-secondary">
                {status.changed} changed · <span className="text-success">+{status.added}</span>{" "}
                <span className="text-destructive">−{status.removed}</span>
              </span>
              {status.conflicted > 0 && (
                <Badge tone="destructive">{status.conflicted} conflicted</Badge>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        {/* Changes + commit */}
        <div className="flex flex-col gap-4">
          <Card>
            <CardContent className="flex flex-col gap-3 py-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-semibold">Changes</h2>
                <Segmented
                  className="w-fit max-w-full flex-wrap"
                  value={scope}
                  onChange={(v) => setScope(v as GitReviewScope)}
                  options={SCOPES}
                />
              </div>
              {files.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  {loading ? "Loading…" : "No changes in this scope."}
                </p>
              ) : (
                <ul className="flex flex-col divide-y divide-current/10">
                  {files.map((file) => (
                    <li key={file.path} className="flex items-center gap-2 py-2">
                      <button
                        type="button"
                        onClick={() => void openDiff(file)}
                        aria-current={selected?.path === file.path ? "true" : undefined}
                        className={cn(
                          "flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-left",
                          "hover:bg-midground/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40",
                          selected?.path === file.path && "bg-midground/10",
                        )}
                      >
                        <span
                          className="w-4 shrink-0 text-center font-mono-ui text-xs text-text-tertiary"
                          aria-hidden
                        >
                          {file.status}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono-ui text-xs">
                          {file.path}
                        </span>
                        <span className="shrink-0 font-mono-ui text-[10px]">
                          <span className="text-success">+{file.added}</span>{" "}
                          <span className="text-destructive">−{file.removed}</span>
                        </span>
                        {file.staged && (
                          <Badge tone="success" className="shrink-0 text-[10px]">
                            staged
                          </Badge>
                        )}
                      </button>
                      <div className="flex shrink-0 items-center gap-1">
                        {file.staged ? (
                          <Button
                            size="sm"
                            ghost
                            disabled={busy !== null}
                            onClick={() =>
                              void run("unstage", () => api.gitUnstageFile(repoPath, file.path), "Unstaged")
                            }
                            aria-label={`Unstage ${file.path}`}
                          >
                            Unstage
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            ghost
                            disabled={busy !== null}
                            onClick={() =>
                              void run("stage", () => api.gitStageFile(repoPath, file.path), "Staged")
                            }
                            aria-label={`Stage ${file.path}`}
                          >
                            Stage
                          </Button>
                        )}
                        <Button
                          size="sm"
                          ghost
                          destructive
                          disabled={busy !== null}
                          onClick={() => setConfirmState({ kind: "revert", file: file.path })}
                          aria-label={`Discard changes to ${file.path}`}
                          title="Discard changes"
                        >
                          <Undo2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex flex-col gap-3 py-4">
              <h2 className="font-semibold">Commit</h2>
              <textarea
                value={message}
                onFocus={() => void loadRecentHint()}
                onChange={(e) => setMessage(e.target.value)}
                rows={3}
                aria-label="Commit message"
                placeholder={
                  canCommit
                    ? "Commit message"
                    : "Stage at least one file to commit"
                }
                className="w-full resize-y rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
              />
              {recentSubjects.length > 0 && (
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-text-tertiary">Recent commits</span>
                  <ul className="flex flex-col gap-0.5">
                    {recentSubjects.map((subject, i) => (
                      <li key={i}>
                        <button
                          type="button"
                          onClick={() => setMessage(subject)}
                          className="truncate text-left text-xs text-text-secondary hover:text-foreground"
                          title={`Use: ${subject}`}
                        >
                          · {subject}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={pushOnCommit}
                  onCheckedChange={setPushOnCommit}
                  aria-label="Push after commit"
                />
                Push after commit
              </label>
              <div className="flex items-center gap-2">
                <Button
                  disabled={!canCommit || !message.trim() || busy !== null}
                  onClick={() =>
                    void run(
                      "commit",
                      async () => {
                        await api.gitCommit(repoPath, message.trim(), pushOnCommit);
                        setMessage("");
                      },
                      pushOnCommit ? "Committed and pushed" : "Committed",
                    )
                  }
                >
                  {busy === "commit" ? <Spinner /> : null}
                  {pushOnCommit ? "Commit & push" : "Commit"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Diff + ship + branches + worktrees */}
        <div className="flex flex-col gap-4">
          <Card>
            <CardContent className="py-4">
              <h2 className="mb-2 font-semibold">
                {selected ? (
                  <span className="font-mono-ui text-xs">{selected.path}</span>
                ) : (
                  "Diff"
                )}
              </h2>
              <div
                role="region"
                aria-label="File diff"
                tabIndex={0}
                className="max-h-[24rem] overflow-auto rounded-md border border-border bg-background-base/60 p-3 focus:outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
              >
                {diffLoading ? (
                  <div className="flex justify-center py-8">
                    <Spinner />
                  </div>
                ) : diff ? (
                  <pre className="whitespace-pre-wrap break-words font-mono-ui text-[11px] leading-5">
                    {diff.split("\n").map((line, i) => (
                      <div key={i} className={diffLineClass(line)}>
                        {line || " "}
                      </div>
                    ))}
                  </pre>
                ) : (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    Select a file to view its diff.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex flex-col gap-3 py-4">
              <h2 className="font-semibold">Ship</h2>
              {ship?.pr ? (
                <a
                  href={ship.pr.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
                >
                  <GitPullRequest className="h-4 w-4" />
                  PR #{ship.pr.number} ({ship.pr.state}) <ExternalLink className="h-3 w-3" />
                </a>
              ) : (
                <p className="text-sm text-text-secondary">
                  {ship?.ghReady === false
                    ? "GitHub CLI (gh) not authenticated — Create PR unavailable."
                    : "No pull request for this branch yet."}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  outlined
                  prefix={<Upload className="h-4 w-4" />}
                  disabled={busy !== null || !repoPath}
                  onClick={() => void run("push", () => api.gitPush(repoPath), "Pushed")}
                >
                  Push
                </Button>
                <Button
                  outlined
                  prefix={<GitPullRequest className="h-4 w-4" />}
                  disabled={busy !== null || !repoPath || ship?.ghReady === false || !!ship?.pr}
                  onClick={() =>
                    void run(
                      "pr",
                      async () => {
                        const res = await api.gitCreatePr(repoPath);
                        if (res.url) window.open(res.url, "_blank", "noopener");
                      },
                      "Pull request created",
                    )
                  }
                >
                  Create PR
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex flex-col gap-2 py-4">
              <h2 className="font-semibold">Branches</h2>
              <ul className="flex flex-col divide-y divide-current/10">
                {branches.map((br) => (
                  <li key={br.name} className="flex items-center justify-between gap-2 py-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-mono-ui text-xs">{br.name}</span>
                      {br.isDefault && <Badge tone="outline" className="text-[10px]">default</Badge>}
                      {br.checkedOut && (
                        <Badge tone="secondary" className="text-[10px]">checked out</Badge>
                      )}
                    </span>
                    <Button
                      size="sm"
                      ghost
                      disabled={busy !== null || br.checkedOut}
                      onClick={() =>
                        void run("switch", () => api.gitSwitchBranch(repoPath, br.name), `Switched to ${br.name}`)
                      }
                      aria-label={`Switch to ${br.name}`}
                    >
                      Switch
                    </Button>
                  </li>
                ))}
                {branches.length === 0 && (
                  <li className="py-3 text-sm text-muted-foreground">No branches.</li>
                )}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex flex-col gap-3 py-4">
              <h2 className="font-semibold">Worktrees</h2>
              <ul className="flex flex-col divide-y divide-current/10">
                {worktrees.map((wt) => (
                  <li key={wt.path} className="flex items-center justify-between gap-2 py-2">
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-mono-ui text-xs">{wt.path}</span>
                      <span className="truncate text-[10px] text-text-tertiary">
                        {wt.branch ?? (wt.detached ? "detached" : "—")}
                        {wt.isMain ? " · main" : ""}
                        {wt.locked ? " · locked" : ""}
                      </span>
                    </span>
                    {!wt.isMain && (
                      <Button
                        size="sm"
                        ghost
                        destructive
                        disabled={busy !== null}
                        onClick={() => setConfirmState({ kind: "removeWorktree", path: wt.path })}
                        aria-label={`Remove worktree ${wt.path}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </li>
                ))}
                {worktrees.length === 0 && (
                  <li className="py-3 text-sm text-muted-foreground">No worktrees.</li>
                )}
              </ul>
              <form
                className="flex flex-wrap items-end gap-2 border-t border-current/10 pt-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  const name = wtName.trim();
                  if (!name) return;
                  void run(
                    "wt-add",
                    async () => {
                      await api.gitAddWorktree(repoPath, {
                        name,
                        branch: name,
                        base: wtBase.trim() || undefined,
                      });
                      setWtName("");
                      setWtBase("");
                    },
                    "Worktree created",
                  );
                }}
              >
                <label className="min-w-0 flex-1">
                  <span className="mb-1 block text-xs text-text-secondary">New worktree / branch</span>
                  <Input value={wtName} onChange={(e) => setWtName(e.target.value)} placeholder="feature-x" className="text-xs" />
                </label>
                <label className="min-w-0 flex-1">
                  <span className="mb-1 block text-xs text-text-secondary">Base (optional)</span>
                  <Input value={wtBase} onChange={(e) => setWtBase(e.target.value)} placeholder="main" className="text-xs" />
                </label>
                <Button type="submit" outlined prefix={<Plus className="h-4 w-4" />} disabled={!wtName.trim() || busy !== null}>
                  Add
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>

      <DeleteConfirmDialog
        open={confirmState !== null}
        loading={busy === "revert" || busy === "wt-remove"}
        title={
          confirmState?.kind === "revert"
            ? "Discard changes?"
            : "Remove worktree?"
        }
        description={
          confirmState?.kind === "revert"
            ? `Permanently discard all uncommitted changes to ${confirmState.file}. This cannot be undone.`
            : confirmState?.kind === "removeWorktree"
              ? `Remove the worktree at ${confirmState.path}.`
              : ""
        }
        confirmLabel={confirmState?.kind === "revert" ? "Discard" : "Remove"}
        onCancel={() => setConfirmState(null)}
        onConfirm={() => {
          if (!confirmState) return;
          const state = confirmState;
          setConfirmState(null);
          if (state.kind === "revert") {
            void run("revert", () => api.gitRevertFile(repoPath, state.file), "Changes discarded");
          } else {
            void run("wt-remove", () => api.gitRemoveWorktree(repoPath, state.path), "Worktree removed");
          }
        }}
      />

      <Toast toast={toast} />
      <PluginSlot name="git:bottom" />
    </div>
  );
}
