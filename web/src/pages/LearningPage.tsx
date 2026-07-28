import { useCallback, useEffect, useState } from "react";
import { Brain, RefreshCw, Save, Trash2, Package, Sparkles } from "lucide-react";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import { Card, CardContent } from "@nous-research/ui/ui/components/card";
import { Input } from "@nous-research/ui/ui/components/input";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { Toast } from "@nous-research/ui/ui/components/toast";
import { useToast } from "@nous-research/ui/hooks/use-toast";

import { api } from "@/lib/api";
import type { LearningGraph, LearningNode } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useProfileScope } from "@/contexts/useProfileScope";
import { usePageHeader } from "@/contexts/usePageHeader";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { PluginSlot } from "@/plugins";

export default function LearningPage() {
  const { profile } = useProfileScope();
  const { toast, showToast } = useToast();
  const { setEnd } = usePageHeader();

  const [graph, setGraph] = useState<LearningGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const [selected, setSelected] = useState<LearningNode | null>(null);
  const [content, setContent] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<LearningNode | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setGraph(await api.getLearningGraph());
    } catch {
      setError("Could not load the learning graph.");
      setGraph(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Re-fetch when the managed profile changes — the graph is profile-scoped.
    // Deferred so the loader's setState isn't called synchronously in-effect.
    queueMicrotask(() => {
      setSelected(null);
      setContent("");
      void load();
    });
  }, [load, profile]);

  useEffect(() => {
    setEnd(
      <Button
        ghost
        size="icon"
        onClick={() => void load()}
        disabled={loading}
        aria-label="Refresh learning graph"
      >
        {loading ? <Spinner /> : <RefreshCw />}
      </Button>,
    );
    return () => setEnd(null);
  }, [setEnd, load, loading]);

  const openNode = useCallback(async (node: LearningNode) => {
    setSelected(node);
    setDetailLoading(true);
    setContent("");
    try {
      const detail = await api.getLearningNode(node.id);
      setContent(detail.content ?? "");
    } catch {
      showToast("Could not load this node.", "error");
      setSelected(null);
    } finally {
      setDetailLoading(false);
    }
  }, [showToast]);

  const save = useCallback(async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await api.updateLearningNode(selected.id, content);
      showToast("Saved", "success");
    } catch {
      showToast("Save failed", "error");
    } finally {
      setSaving(false);
    }
  }, [selected, content, showToast]);

  const runDelete = useCallback(async () => {
    if (!confirmDelete) return;
    const node = confirmDelete;
    setDeleting(true);
    try {
      await api.deleteLearningNode(node.id);
      showToast(node.kind === "skill" ? "Skill archived" : "Memory removed", "success");
      setConfirmDelete(null);
      if (selected?.id === node.id) {
        setSelected(null);
        setContent("");
      }
      await load();
    } catch {
      showToast("Delete failed", "error");
    } finally {
      setDeleting(false);
    }
  }, [confirmDelete, selected, load, showToast]);

  const nodes = graph?.nodes ?? [];
  const q = query.trim().toLowerCase();
  const filtered = q
    ? nodes.filter(
        (n) => n.label.toLowerCase().includes(q) || n.category.toLowerCase().includes(q),
      )
    : nodes;
  const skills = filtered.filter((n) => n.kind === "skill");
  const memories = filtered.filter((n) => n.kind === "memory");

  const NodeRow = ({ node }: { node: LearningNode }) => (
    <li className="flex items-center gap-2 py-1.5">
      <button
        type="button"
        onClick={() => void openNode(node)}
        aria-current={selected?.id === node.id ? "true" : undefined}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1 text-left",
          "hover:bg-midground/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40",
          selected?.id === node.id && "bg-midground/10",
        )}
      >
        {node.kind === "skill" ? (
          <Package className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden />
        ) : (
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden />
        )}
        <span className="min-w-0 flex-1 truncate text-sm">{node.label}</span>
        {node.pinned && <Badge tone="outline" className="text-[10px]">pinned</Badge>}
        {node.useCount > 0 && (
          <span className="shrink-0 text-[10px] text-text-tertiary">{node.useCount}×</span>
        )}
      </button>
      <Button
        size="sm"
        ghost
        destructive
        onClick={() => setConfirmDelete(node)}
        aria-label={`${node.kind === "skill" ? "Archive" : "Remove"} ${node.label}`}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </li>
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-1 sm:p-3">
      <PluginSlot name="learning:top" />
      <p className="text-sm text-muted-foreground">
        Skills Imperator has learned and the memory it has formed — view, edit
        or prune each. Scoped to the managed profile.
      </p>

      {graph && (
        <div className="flex flex-wrap gap-2 text-sm">
          <Badge tone="secondary">{skills.length} learned skills</Badge>
          <Badge tone="secondary">{memories.length} memory chunks</Badge>
          {graph.clusters.slice(0, 6).map((c) => (
            <Badge key={c.category} tone="outline">
              {c.category} · {c.count}
            </Badge>
          ))}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Card>
          <CardContent className="flex flex-col gap-3 py-4">
            <label className="flex items-center gap-2">
              <Brain className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden />
              <span className="sr-only">Filter nodes</span>
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter by name or category"
                className="text-sm"
              />
            </label>

            {loading ? (
              <div className="flex justify-center py-10">
                <Spinner />
              </div>
            ) : error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : filtered.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {nodes.length === 0
                  ? "No learned skills or memory yet."
                  : "No nodes match that filter."}
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {skills.length > 0 && (
                  <div>
                    <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-tertiary">
                      Skills
                    </h2>
                    <ul className="flex flex-col divide-y divide-current/10">
                      {skills.map((n) => (
                        <NodeRow key={n.id} node={n} />
                      ))}
                    </ul>
                  </div>
                )}
                {memories.length > 0 && (
                  <div>
                    <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-tertiary">
                      Memory
                    </h2>
                    <ul className="flex flex-col divide-y divide-current/10">
                      {memories.map((n) => (
                        <NodeRow key={n.id} node={n} />
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex flex-col gap-3 py-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="min-w-0 truncate font-semibold">
                {selected ? selected.label : "Node content"}
              </h2>
              {selected && (
                <Button
                  size="sm"
                  onClick={() => void save()}
                  disabled={saving || detailLoading}
                  prefix={saving ? <Spinner /> : <Save className="h-4 w-4" />}
                >
                  Save
                </Button>
              )}
            </div>
            {detailLoading ? (
              <div className="flex justify-center py-10">
                <Spinner />
              </div>
            ) : selected ? (
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                aria-label={`Content of ${selected.label}`}
                spellCheck={false}
                className="min-h-[24rem] w-full resize-y rounded-md border border-border bg-background-base/60 px-3 py-2 font-mono-ui text-xs leading-5 outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
              />
            ) : (
              <p className="py-10 text-center text-sm text-muted-foreground">
                Select a skill or memory to view and edit it.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <DeleteConfirmDialog
        open={confirmDelete !== null}
        loading={deleting}
        title={confirmDelete?.kind === "skill" ? "Archive skill?" : "Remove memory?"}
        description={
          confirmDelete?.kind === "skill"
            ? `Archive "${confirmDelete?.label}". Archived skills can be restored.`
            : `Permanently remove the memory "${confirmDelete?.label}".`
        }
        confirmLabel={confirmDelete?.kind === "skill" ? "Archive" : "Remove"}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => void runDelete()}
      />

      <Toast toast={toast} />
      <PluginSlot name="learning:bottom" />
    </div>
  );
}
