import { useCallback, useEffect, useState } from "react";
import { ChevronRight, File as FileIcon, Folder, RefreshCw, Save } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import { Card, CardContent } from "@nous-research/ui/ui/components/card";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { Toast } from "@nous-research/ui/ui/components/toast";
import { useToast } from "@nous-research/ui/hooks/use-toast";

import { api } from "@/lib/api";
import type { FsEntry } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Compact server file browser + text editor for the coding rail
 * (/api/fs/list | read-text | write-text). Navigate directories, open a
 * text file, edit and save. Binary/oversized files are shown read-only.
 */
export function FileBrowser({ root }: { root: string }) {
  const { toast, showToast } = useToast();
  // Seeded from `root`; the parent keys this component by root, so a new repo
  // remounts it rather than syncing a prop into state inside an effect.
  const [cwd, setCwd] = useState(root);
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [openFile, setOpenFile] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const list = useCallback(async (path: string) => {
    if (!path) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.fsList(path);
      setEntries(res.entries);
      if (res.error) setError(res.error);
    } catch {
      setEntries([]);
      setError("Could not list this directory.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void list(cwd));
  }, [cwd, list]);

  const openText = useCallback(async (path: string) => {
    setOpenFile(path);
    setFileLoading(true);
    setText("");
    try {
      const res = await api.fsReadText(path);
      setReadOnly(res.binary || res.truncated);
      setText(res.binary ? "(binary file — not shown)" : res.text);
    } catch {
      setReadOnly(true);
      setText("Could not read this file.");
    } finally {
      setFileLoading(false);
    }
  }, []);

  const save = useCallback(async () => {
    if (!openFile) return;
    setSaving(true);
    try {
      await api.fsWriteText(openFile, text);
      showToast("Saved", "success");
    } catch {
      showToast("Save failed", "error");
    } finally {
      setSaving(false);
    }
  }, [openFile, text, showToast]);

  const parent = cwd.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="min-w-0 truncate font-semibold">Browse files</h2>
          <Button ghost size="icon" onClick={() => void list(cwd)} aria-label="Refresh listing">
            {loading ? <Spinner /> : <RefreshCw />}
          </Button>
        </div>
        <p className="truncate font-mono-ui text-xs text-text-tertiary" title={cwd}>
          {cwd}
        </p>

        <div className="grid gap-3 lg:grid-cols-2">
          <div className="max-h-72 overflow-auto rounded-md border border-border">
            <ul className="flex flex-col divide-y divide-current/10">
              {cwd !== "/" && (
                <li>
                  <button
                    type="button"
                    onClick={() => setCwd(parent)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-midground/5"
                  >
                    <Folder className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden />
                    ..
                  </button>
                </li>
              )}
              {entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    onClick={() =>
                      entry.isDirectory ? setCwd(entry.path) : void openText(entry.path)
                    }
                    aria-current={openFile === entry.path ? "true" : undefined}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-midground/5",
                      openFile === entry.path && "bg-midground/10",
                    )}
                  >
                    {entry.isDirectory ? (
                      <Folder className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
                    ) : (
                      <FileIcon className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden />
                    )}
                    <span className="min-w-0 flex-1 truncate font-mono-ui">{entry.name}</span>
                    {entry.isDirectory && (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden />
                    )}
                  </button>
                </li>
              ))}
              {!loading && entries.length === 0 && (
                <li className="px-3 py-3 text-xs text-muted-foreground">
                  {error ?? "Empty directory."}
                </li>
              )}
            </ul>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate font-mono-ui text-xs text-text-secondary" title={openFile ?? ""}>
                {openFile ? openFile.split("/").pop() : "No file open"}
              </span>
              {openFile && !readOnly && (
                <Button
                  size="sm"
                  onClick={() => void save()}
                  disabled={saving || fileLoading}
                  prefix={saving ? <Spinner /> : <Save className="h-4 w-4" />}
                >
                  Save
                </Button>
              )}
            </div>
            {fileLoading ? (
              <div className="flex justify-center py-8">
                <Spinner />
              </div>
            ) : openFile ? (
              <textarea
                value={text}
                readOnly={readOnly}
                onChange={(e) => setText(e.target.value)}
                aria-label={`Contents of ${openFile}`}
                spellCheck={false}
                className="min-h-64 w-full resize-y rounded-md border border-border bg-background-base/60 px-3 py-2 font-mono-ui text-[11px] leading-5 outline-none focus-visible:ring-1 focus-visible:ring-primary/40 read-only:opacity-70"
              />
            ) : (
              <p className="py-8 text-center text-xs text-muted-foreground">
                Select a file to view or edit it.
              </p>
            )}
            {readOnly && openFile && !fileLoading && (
              <p className="text-[10px] text-text-tertiary">Read-only (binary or truncated).</p>
            )}
          </div>
        </div>
        <Toast toast={toast} />
      </CardContent>
    </Card>
  );
}
