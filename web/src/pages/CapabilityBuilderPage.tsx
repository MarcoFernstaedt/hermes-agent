import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Trash2, Wand2 } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import { Input } from "@nous-research/ui/ui/components/input";
import { Label } from "@nous-research/ui/ui/components/label";
import { Select, SelectOption } from "@nous-research/ui/ui/components/select";
import { Checkbox } from "@nous-research/ui/ui/components/checkbox";
import { Toast } from "@nous-research/ui/ui/components/toast";
import { useToast } from "@nous-research/ui/hooks/use-toast";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  FIELD_TYPES,
  declarationToDraft,
  describeDeclaration,
  draftToDeclaration,
  emptyDraft,
  slugify,
  type Draft,
  type DraftField,
} from "@/capabilities/builder-model";
import { TEMPLATES } from "@/capabilities/templates";

/**
 * The visual capability builder — the human authoring path. Define entities,
 * fields, lifecycle and views through a fully keyboard/NVDA-operable form; the
 * declaration is validated live against the same server schema the agent path
 * uses, and "Propose" files the identical artifact to the review queue. What you
 * build is what ships: the declaration here is exactly what the renderer draws.
 */
export default function CapabilityBuilderPage() {
  const navigate = useNavigate();
  const { toast, showToast } = useToast();
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [errors, setErrors] = useState<string[]>([]);
  const [idEdited, setIdEdited] = useState(false);
  const [existing, setExisting] = useState<Record<string, unknown>[]>([]);
  const [busy, setBusy] = useState(false);

  const declaration = useMemo(() => draftToDeclaration(draft), [draft]);

  useEffect(() => {
    api.getCapabilities().then((r) => setExisting(r.capabilities as unknown as Record<string, unknown>[])).catch(() => {});
  }, []);

  // Live validation against the shared server schema (debounced).
  useEffect(() => {
    if (!draft.id && !draft.label) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing stale errors when the form is empty.
      setErrors([]);
      return;
    }
    const t = setTimeout(() => {
      api
        .validateCapability(declaration)
        .then((r) => setErrors(r.errors))
        .catch(() => setErrors([]));
    }, 300);
    return () => clearTimeout(t);
  }, [declaration, draft.id, draft.label]);

  const selectFields = draft.fields.filter((f) => f.type === "select" && (f.options?.length ?? 0) > 0);
  const valid = errors.length === 0 && !!draft.id && !!draft.label && !!draft.titleField;

  const update = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setField = (i: number, patch: Partial<DraftField>) =>
    setDraft((d) => ({ ...d, fields: d.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) }));

  const cloneFrom = (id: string) => {
    const decl = existing.find((c) => c.id === id);
    if (decl) {
      const d = declarationToDraft(decl);
      d.id = "";
      d.label = `${d.label} copy`;
      setIdEdited(false);
      setDraft(d);
    }
  };

  const propose = async () => {
    setBusy(true);
    try {
      await api.createProposal({
        kind: "capability",
        title: `Add the "${draft.label}" capability`,
        summary: describeDeclaration(declaration).join(" "),
        source: "human",
        risk: "low",
        payload: { declaration },
        preview: { id: draft.id, label: draft.label },
      });
      showToast("Proposed — review and approve it in the queue.", "success");
      setTimeout(() => navigate("/review"), 700);
    } catch {
      showToast("Could not file the proposal.", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Wand2 className="size-5 text-midground" aria-hidden />
          <h1 className="text-lg font-semibold">New capability</h1>
        </div>
        <label className="flex items-center gap-2 text-xs text-text-secondary">
          <span>Template</span>
          <Select
            value=""
            onValueChange={(id) => {
              const t = TEMPLATES.find((x) => x.id === id);
              if (t) {
                setIdEdited(true);
                setDraft({ ...t.draft });
              }
            }}
            aria-label="Start from a template"
          >
            <SelectOption value="">Blank</SelectOption>
            {TEMPLATES.map((t) => (
              <SelectOption key={t.id} value={t.id}>{t.name}</SelectOption>
            ))}
          </Select>
        </label>
        {existing.length > 0 && (
          <label className="flex items-center gap-2 text-xs text-text-secondary">
            <span>Start from</span>
            <Select value="" onValueChange={cloneFrom} aria-label="Start from an existing capability">
              <SelectOption value="">Blank</SelectOption>
              {existing.map((c) => (
                <SelectOption key={String(c.id)} value={String(c.id)}>
                  {String(c.label)}
                </SelectOption>
              ))}
            </Select>
          </label>
        )}
      </header>

      {/* Basics */}
      <section className="flex flex-col gap-3" aria-labelledby="basics-h">
        <h2 id="basics-h" className="text-sm font-semibold text-text-secondary">Basics</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="cap-label">Name</Label>
            <Input
              id="cap-label"
              value={draft.label}
              placeholder="Reading list"
              onChange={(e) => {
                const label = e.target.value;
                update({ label, id: idEdited ? draft.id : slugify(label) });
              }}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="cap-id">Id (route + storage key)</Label>
            <Input
              id="cap-id"
              value={draft.id}
              placeholder="reading-list"
              onChange={(e) => {
                setIdEdited(true);
                update({ id: e.target.value });
              }}
            />
          </div>
        </div>
      </section>

      {/* Fields */}
      <section className="flex flex-col gap-3" aria-labelledby="fields-h">
        <div className="flex items-center justify-between">
          <h2 id="fields-h" className="text-sm font-semibold text-text-secondary">Fields</h2>
          <Button
            size="sm"
            ghost
            prefix={<Plus />}
            onClick={() =>
              update({ fields: [...draft.fields, { name: "", label: "", type: "text" }] })
            }
          >
            Add field
          </Button>
        </div>
        <ul className="flex flex-col gap-2">
          {draft.fields.map((f, i) => (
            <li key={i} className="grid grid-cols-1 gap-2 rounded-md border border-current/10 p-2 sm:grid-cols-[1fr_1fr_auto_auto_auto]">
              <Input
                aria-label={`Field ${i + 1} name`}
                placeholder="field_name"
                value={f.name}
                onChange={(e) => setField(i, { name: e.target.value })}
              />
              <Input
                aria-label={`Field ${i + 1} label`}
                placeholder="Label"
                value={f.label}
                onChange={(e) => setField(i, { label: e.target.value })}
              />
              <Select
                aria-label={`Field ${i + 1} type`}
                value={f.type}
                onValueChange={(v) => setField(i, { type: v as DraftField["type"] })}
              >
                {FIELD_TYPES.map((t) => (
                  <SelectOption key={t} value={t}>{t}</SelectOption>
                ))}
              </Select>
              <label className="flex items-center gap-1 text-xs text-text-secondary">
                <Checkbox
                  checked={!!f.required}
                  onCheckedChange={(v) => setField(i, { required: !!v })}
                  aria-label={`Field ${i + 1} required`}
                />
                req
              </label>
              <button
                type="button"
                aria-label={`Remove field ${i + 1}`}
                onClick={() => update({ fields: draft.fields.filter((_, j) => j !== i) })}
                className="rounded p-1 text-text-tertiary hover:text-destructive"
              >
                <Trash2 className="size-4" aria-hidden />
              </button>
              {f.type === "select" && (
                <div className="sm:col-span-5">
                  <Label htmlFor={`opts-${i}`} className="text-[0.68rem] text-text-tertiary">
                    Options — one <code>value = Label</code> per line
                  </Label>
                  <textarea
                    id={`opts-${i}`}
                    className="mt-1 w-full rounded-md border border-current/15 bg-background/40 p-2 font-mono-ui text-xs"
                    rows={3}
                    placeholder={"todo = To do\ndoing = Doing\ndone = Done"}
                    value={(f.options ?? []).map((o) => `${o.value} = ${o.label}`).join("\n")}
                    onChange={(e) =>
                      setField(i, {
                        options: e.target.value
                          .split("\n")
                          .map((line) => line.split("="))
                          .filter((parts) => parts[0]?.trim())
                          .map((parts) => ({
                            value: parts[0].trim(),
                            label: (parts[1] ?? parts[0]).trim(),
                          })),
                      })
                    }
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      {/* Shape */}
      <section className="grid gap-3 sm:grid-cols-3" aria-labelledby="shape-h">
        <h2 id="shape-h" className="sm:col-span-3 text-sm font-semibold text-text-secondary">Shape</h2>
        <div className="flex flex-col gap-1">
          <Label htmlFor="title-field">Title field</Label>
          <Select id="title-field" value={draft.titleField} onValueChange={(v) => update({ titleField: v })}>
            <SelectOption value="">—</SelectOption>
            {draft.fields.filter((f) => f.name).map((f) => (
              <SelectOption key={f.name} value={f.name}>{f.label || f.name}</SelectOption>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="subtitle-field">Subtitle field</Label>
          <Select id="subtitle-field" value={draft.subtitleField ?? ""} onValueChange={(v) => update({ subtitleField: v || undefined })}>
            <SelectOption value="">—</SelectOption>
            {draft.fields.filter((f) => f.name).map((f) => (
              <SelectOption key={f.name} value={f.name}>{f.label || f.name}</SelectOption>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="lifecycle-field">Board by (a select field)</Label>
          <Select id="lifecycle-field" value={draft.lifecycleField ?? ""} onValueChange={(v) => update({ lifecycleField: v || undefined })}>
            <SelectOption value="">No board (table only)</SelectOption>
            {selectFields.map((f) => (
              <SelectOption key={f.name} value={f.name}>{f.label || f.name}</SelectOption>
            ))}
          </Select>
        </div>
      </section>

      {/* Views */}
      <section className="flex flex-col gap-2" aria-labelledby="views-h">
        <h2 id="views-h" className="text-sm font-semibold text-text-secondary">Views</h2>
        <p className="text-xs text-text-tertiary">
          A table is always available. Add the shapes that suit this data.
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={!!draft.gallery}
              onCheckedChange={(v) => update({ gallery: !!v })}
              aria-label="Add a gallery view"
            />
            Gallery (cards)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <span>Agenda by</span>
            <Select
              value={draft.agendaField ?? ""}
              onValueChange={(v) => update({ agendaField: v || undefined })}
              aria-label="Agenda date field"
            >
              <SelectOption value="">No agenda</SelectOption>
              {draft.fields
                .filter((f) => f.type === "date" && f.name)
                .map((f) => (
                  <SelectOption key={f.name} value={f.name}>{f.label || f.name}</SelectOption>
                ))}
            </Select>
          </label>
        </div>
      </section>

      {/* Preview + validation */}
      <section className="flex flex-col gap-2 rounded-lg border border-current/10 bg-midground/[0.02] p-3" aria-labelledby="preview-h">
        <h2 id="preview-h" className="text-sm font-semibold text-text-secondary">What this creates</h2>
        <ul className="list-disc pl-5 text-sm text-text-secondary">
          {describeDeclaration(declaration).map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
        {errors.length > 0 && (
          <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            <p className="font-semibold">Not valid yet:</p>
            <ul className="list-disc pl-4">
              {errors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          </div>
        )}
      </section>

      <div className="flex items-center justify-end gap-2">
        <Button ghost onClick={() => navigate("/review")}>Cancel</Button>
        <Button disabled={!valid || busy} onClick={propose}>
          Propose to review
        </Button>
      </div>

      <details className="text-xs text-text-tertiary">
        <summary className="cursor-pointer">Inspect the declaration</summary>
        <pre className={cn("mt-2 max-h-72 overflow-auto rounded-md bg-background/40 p-3 font-mono-ui")}>
          {JSON.stringify(declaration, null, 2)}
        </pre>
      </details>

      <Toast toast={toast} />
    </div>
  );
}
