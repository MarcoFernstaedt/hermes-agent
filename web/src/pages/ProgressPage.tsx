import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Activity, Minus, Plus, Target } from "lucide-react";

import { api } from "@/lib/api";
import type {
  LifeHabit,
  LifeHabitCreate,
  LifeHabitUpdate,
  LifeHistoryDay,
  LifeReflectionUpdate,
  LifeToday,
} from "@/lib/life";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import { Card } from "@nous-research/ui/ui/components/card";
import { Input } from "@nous-research/ui/ui/components/input";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { cn } from "@/lib/utils";

export type ProgressViewState = "loading" | "ready" | "error";

interface ProgressViewProps {
  state: ProgressViewState;
  today: LifeToday | null;
  history: LifeHistoryDay[];
  error?: string;
  announcement?: string;
  operationError?: string;
  pendingHabitIds?: number[];
  addingHabit?: boolean;
  savingReflection?: boolean;
  onRetry: () => void;
  onIncrement: (habit: LifeHabit) => void;
  onDecrement: (habit: LifeHabit) => void;
  onAddHabit: (habit: LifeHabitCreate) => Promise<boolean>;
  onUpdateHabit: (habit: LifeHabit, update: LifeHabitUpdate) => Promise<boolean>;
  onSaveReflection: (reflection: LifeReflectionUpdate) => void;
}

const EMPTY_REFLECTION: LifeReflectionUpdate = {
  wake_time: "",
  bedtime: "",
  energy: null,
  mood: "",
  win: "",
  obstacle: "",
  lesson: "",
  tomorrow: "",
};

const fieldClass =
  "min-h-11 w-full border border-current/20 bg-background/40 px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-midground";

function readableNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

interface HabitEditorProps {
  habit: LifeHabit;
  pending: boolean;
  onUpdate: (habit: LifeHabit, update: LifeHabitUpdate) => Promise<boolean>;
}

function HabitEditor({ habit, pending, onUpdate }: HabitEditorProps) {
  const [draft, setDraft] = useState<LifeHabitCreate>({
    name: habit.name,
    category: habit.category,
    target: habit.target,
    unit: habit.unit,
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await onUpdate(habit, {
      ...draft,
      name: draft.name.trim(),
      category: draft.category.trim(),
      unit: draft.unit.trim(),
    });
  };

  return (
    <details className="mt-3 border-t border-current/10 pt-2">
      <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">Manage habit</summary>
      <form onSubmit={(event) => void submit(event)} className="grid gap-2 sm:grid-cols-2">
        <label className="grid gap-1 text-xs">
          Name
          <Input required maxLength={100} value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
        </label>
        <label className="grid gap-1 text-xs">
          Category
          <Input required maxLength={40} value={draft.category} onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value }))} />
        </label>
        <label className="grid gap-1 text-xs">
          Daily target
          <Input required type="number" min="0.1" max="10000" step="0.1" value={draft.target} onChange={(event) => setDraft((current) => ({ ...current, target: Number(event.target.value) }))} />
        </label>
        <label className="grid gap-1 text-xs">
          Unit
          <Input required maxLength={30} value={draft.unit} onChange={(event) => setDraft((current) => ({ ...current, unit: event.target.value }))} />
        </label>
        <Button type="submit" disabled={pending} className="min-h-11">Save changes</Button>
        <Button outlined type="button" disabled={pending} onClick={() => void onUpdate(habit, { active: false })} className="min-h-11">
          Deactivate habit
        </Button>
      </form>
    </details>
  );
}

interface ReflectionFormProps {
  initial: LifeToday["reflection"];
  operationBusy: boolean;
  saving: boolean;
  onSave: (reflection: LifeReflectionUpdate) => void;
}

function ReflectionForm({ initial, operationBusy, saving, onSave }: ReflectionFormProps) {
  const [reflection, setReflection] = useState<LifeReflectionUpdate>(() =>
    initial
      ? {
          wake_time: initial.wake_time,
          bedtime: initial.bedtime,
          energy: initial.energy,
          mood: initial.mood,
          win: initial.win,
          obstacle: initial.obstacle,
          lesson: initial.lesson,
          tomorrow: initial.tomorrow,
        }
      : EMPTY_REFLECTION,
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave(reflection);
  };

  return (
    <form onSubmit={submit} className="grid gap-3 border border-current/15 p-4 sm:grid-cols-2">
      <label className="grid gap-1 text-sm">
        Wake time
        <input className={fieldClass} type="time" value={reflection.wake_time} onChange={(event) => setReflection((current) => ({ ...current, wake_time: event.target.value }))} />
      </label>
      <label className="grid gap-1 text-sm">
        Bedtime
        <input className={fieldClass} type="time" value={reflection.bedtime} onChange={(event) => setReflection((current) => ({ ...current, bedtime: event.target.value }))} />
      </label>
      <label className="grid gap-1 text-sm">
        Energy, 1 to 5
        <select className={fieldClass} value={reflection.energy ?? ""} onChange={(event) => setReflection((current) => ({ ...current, energy: event.target.value ? Number(event.target.value) : null }))}>
          <option value="">Not recorded</option>
          {[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-sm">
        Mood
        <Input maxLength={40} value={reflection.mood} onChange={(event) => setReflection((current) => ({ ...current, mood: event.target.value }))} />
      </label>
      {([
        ["win", "What went well"],
        ["obstacle", "Obstacle or ugly part"],
        ["lesson", "What I learned"],
        ["tomorrow", "Tomorrow's one outcome"],
      ] as const).map(([key, label]) => (
        <label key={key} className="grid gap-1 text-sm sm:col-span-2">
          {label}
          <textarea
            className={cn(fieldClass, "min-h-20 resize-y")}
            maxLength={500}
            value={reflection[key]}
            onChange={(event) => setReflection((current) => ({ ...current, [key]: event.target.value }))}
          />
        </label>
      ))}
      <Button type="submit" disabled={operationBusy} className="min-h-11 sm:col-span-2">
        {saving ? "Saving…" : "Save daily reflection"}
      </Button>
    </form>
  );
}

export function ProgressView({
  state,
  today,
  history,
  error,
  announcement = "",
  operationError = "",
  pendingHabitIds = [],
  addingHabit = false,
  savingReflection = false,
  onRetry,
  onIncrement,
  onDecrement,
  onAddHabit,
  onUpdateHabit,
  onSaveReflection,
}: ProgressViewProps) {
  const [newHabit, setNewHabit] = useState<LifeHabitCreate>({
    name: "",
    category: "health",
    target: 1,
    unit: "check",
  });
  const operationBusy = pendingHabitIds.length > 0 || addingHabit || savingReflection;

  const submitHabit = async (event: FormEvent) => {
    event.preventDefault();
    if (!newHabit.name.trim()) return;
    const added = await onAddHabit({ ...newHabit, name: newHabit.name.trim() });
    if (added) {
      setNewHabit({ name: "", category: newHabit.category, target: 1, unit: "check" });
    }
  };

  return (
    <section aria-labelledby="progress-heading" className="mx-auto w-full max-w-6xl space-y-5 p-4 sm:p-6">
      <header className="flex items-center gap-3">
        <Activity aria-hidden className="size-5 text-primary" />
        <div>
          <h2 id="progress-heading" className="text-lg font-semibold">Daily progress</h2>
          <p className="text-sm text-text-secondary">One outcome, minimum machinery, verified result.</p>
        </div>
      </header>
      <p className="sr-only" aria-live="polite">{announcement}</p>
      {operationError && (
        <p role="alert" className="border border-destructive/50 bg-destructive/[0.06] p-3 text-sm">
          {operationError}
        </p>
      )}

      {state === "loading" && (
        <p role="status" className="flex items-center justify-center gap-2 py-16 text-sm text-text-secondary">
          <Spinner className="text-xl text-primary" /> Loading progress…
        </p>
      )}

      {state === "error" && (
        <section role="alert" className="space-y-3 border border-destructive/50 bg-destructive/[0.06] p-4">
          <p className="text-sm">{error || "Progress could not load."}</p>
          <Button outlined onClick={onRetry}>Retry</Button>
        </section>
      )}

      {state === "ready" && today && (
        <>
          <Card
            role="status"
            className={cn(
              "border-l-4 p-4",
              today.income_gate.open ? "border-l-success" : "border-l-warning",
            )}
          >
            <div className="flex items-start gap-3">
              <Target aria-hidden className={cn("mt-0.5 size-5", today.income_gate.open ? "text-success" : "text-warning")} />
              <div>
                <h3 className="font-semibold">{today.income_gate.open ? "Income gate open" : "Income gate closed"}</h3>
                <p className="mt-1 text-sm text-text-secondary">{today.income_gate.message}</p>
                <p className="mt-2 text-sm font-medium">
                  Today: {today.totals.completed} of {today.totals.active} complete
                </p>
              </div>
            </div>
          </Card>

          <section aria-labelledby="habits-heading">
            <h3 id="habits-heading" className="mb-3 text-base font-semibold">Today&apos;s habits</h3>
            <div className="grid gap-3 lg:grid-cols-2">
              {today.habits.map((habit) => {
                const pending = operationBusy;
                return (
                  <Card key={habit.id} className={cn("p-4", habit.complete && "border-success/40")}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h4 className="font-semibold">{habit.name}</h4>
                        <p className="mt-1 text-xs text-text-secondary">
                          <Badge tone={habit.complete ? "success" : "outline"}>{habit.category}</Badge>{" "}
                          Goal {readableNumber(habit.target)} {habit.unit}
                        </p>
                      </div>
                      <p className={cn("font-mono-ui text-xl tabular-nums", habit.complete ? "text-success" : "text-foreground")}>
                        {readableNumber(habit.value)}
                      </p>
                    </div>
                    {habit.note && <p className="mt-2 text-sm text-text-secondary">{habit.note}</p>}
                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        aria-label={`Remove one from ${habit.name}`}
                        disabled={pending || habit.value <= 0}
                        onClick={() => onDecrement(habit)}
                        className="inline-flex min-h-11 min-w-11 items-center justify-center border border-current/25 disabled:opacity-40"
                      >
                        <Minus aria-hidden className="size-4" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Add one to ${habit.name}`}
                        disabled={pending}
                        onClick={() => onIncrement(habit)}
                        className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 border border-primary/50 bg-primary/10 px-4 text-sm font-medium disabled:opacity-40"
                      >
                        <Plus aria-hidden className="size-4" />
                        {pending ? "Saving…" : habit.complete ? "Add another" : "Mark progress"}
                      </button>
                    </div>
                    <HabitEditor
                      key={`${habit.id}:${habit.name}:${habit.category}:${habit.target}:${habit.unit}`}
                      habit={habit}
                      pending={pending}
                      onUpdate={onUpdateHabit}
                    />
                  </Card>
                );
              })}
            </div>
          </section>

          <details className="border border-current/15 p-4">
            <summary className="min-h-11 cursor-pointer py-2 font-semibold">Add a habit</summary>
            <form onSubmit={(event) => void submitHabit(event)} className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1 text-sm">
                Habit name
                <Input
                  required
                  maxLength={100}
                  value={newHabit.name}
                  onChange={(event) => setNewHabit((current) => ({ ...current, name: event.target.value }))}
                />
              </label>
              <label className="grid gap-1 text-sm">
                Category
                <Input
                  required
                  maxLength={40}
                  value={newHabit.category}
                  onChange={(event) => setNewHabit((current) => ({ ...current, category: event.target.value }))}
                />
              </label>
              <label className="grid gap-1 text-sm">
                Daily target
                <Input
                  required
                  type="number"
                  min="0.1"
                  max="10000"
                  step="0.1"
                  value={newHabit.target}
                  onChange={(event) => setNewHabit((current) => ({ ...current, target: Number(event.target.value) }))}
                />
              </label>
              <label className="grid gap-1 text-sm">
                Unit
                <Input
                  required
                  maxLength={30}
                  value={newHabit.unit}
                  onChange={(event) => setNewHabit((current) => ({ ...current, unit: event.target.value }))}
                />
              </label>
              <Button type="submit" disabled={operationBusy} className="min-h-11 sm:col-span-2">
                {addingHabit ? "Adding…" : "Add habit"}
              </Button>
            </form>
          </details>

          <section aria-labelledby="history-heading">
            <h3 id="history-heading" className="mb-3 text-base font-semibold">Last 14 days</h3>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-7">
              {history.map((item) => (
                <Card key={item.day} className="p-3 text-center">
                  <p className="text-xs text-text-secondary">{item.day.slice(5)}</p>
                  <p className="mt-1 font-mono-ui text-lg tabular-nums">{item.completed}/{item.active}</p>
                </Card>
              ))}
            </div>
          </section>

          <section aria-labelledby="reflection-heading">
            <h3 id="reflection-heading" className="mb-3 text-base font-semibold">Daily reflection</h3>
            <ReflectionForm
              key={today.day}
              initial={today.reflection}
              operationBusy={operationBusy}
              saving={savingReflection}
              onSave={onSaveReflection}
            />
          </section>

          {today.timeline.length > 0 && (
            <details className="border border-current/15 p-4">
              <summary className="min-h-11 cursor-pointer py-2 font-semibold">Today&apos;s timeline</summary>
              <ol className="mt-2 space-y-2">
                {today.timeline.map((event) => (
                  <li key={event.id} className="text-sm">
                    <time className="font-mono-ui text-text-secondary" dateTime={event.occurred_at}>
                      {new Date(event.occurred_at).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                        timeZone: "America/Phoenix",
                      })}
                    </time>{" "}
                    {event.habit_name}: {readableNumber(event.value)} {event.note ? `— ${event.note}` : ""}
                  </li>
                ))}
              </ol>
            </details>
          )}
        </>
      )}
    </section>
  );
}

export default function ProgressPage() {
  const [state, setState] = useState<ProgressViewState>("loading");
  const [today, setToday] = useState<LifeToday | null>(null);
  const [history, setHistory] = useState<LifeHistoryDay[]>([]);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [operationError, setOperationError] = useState("");
  const [pendingHabitIds, setPendingHabitIds] = useState<number[]>([]);
  const [addingHabit, setAddingHabit] = useState(false);
  const [savingReflection, setSavingReflection] = useState(false);
  const pendingHabitIdsRef = useRef(new Set<number>());
  const addingHabitRef = useRef(false);
  const mutationInFlightRef = useRef(false);
  const mutationSequenceRef = useRef(0);

  const load = useCallback(async () => {
    setState("loading");
    setError("");
    try {
      const [current, past] = await Promise.all([
        api.getLifeToday(),
        api.getLifeHistory(14),
      ]);
      setToday(current);
      setHistory(past.items);
      setState("ready");
    } catch {
      setError("Progress could not load.");
      setState("error");
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  const refreshAfterMutation = async (sequence: number, day: string) => {
    const [current, past] = await Promise.all([
      api.getLifeToday(day),
      api.getLifeHistory(14, day),
    ]);
    if (sequence !== mutationSequenceRef.current) return;
    setToday(current);
    setHistory(past.items);
  };

  const beginHabitMutation = (habitId: number): number | null => {
    if (mutationInFlightRef.current) return null;
    mutationInFlightRef.current = true;
    pendingHabitIdsRef.current.add(habitId);
    setPendingHabitIds([...pendingHabitIdsRef.current]);
    setOperationError("");
    return ++mutationSequenceRef.current;
  };

  const endHabitMutation = (habitId: number) => {
    pendingHabitIdsRef.current.delete(habitId);
    setPendingHabitIds([...pendingHabitIdsRef.current]);
    mutationInFlightRef.current = false;
  };

  const changeHabit = async (habit: LifeHabit, delta: number) => {
    if (!today) return;
    const sequence = beginHabitMutation(habit.id);
    if (sequence === null) return;
    const day = today.day;
    const value = Math.max(0, habit.value + delta);
    try {
      await api.setLifeEntry(habit.id, day, value, habit.note);
      await refreshAfterMutation(sequence, day);
      if (sequence === mutationSequenceRef.current) {
        setAnnouncement(`${habit.name} updated to ${readableNumber(value)}.`);
      }
    } catch {
      if (sequence === mutationSequenceRef.current) {
        setOperationError(`${habit.name} was not updated. Try again.`);
        setAnnouncement(`${habit.name} was not updated.`);
      }
    } finally {
      endHabitMutation(habit.id);
    }
  };

  const addHabit = async (habit: LifeHabitCreate): Promise<boolean> => {
    if (mutationInFlightRef.current || addingHabitRef.current || !today) return false;
    mutationInFlightRef.current = true;
    addingHabitRef.current = true;
    setAddingHabit(true);
    setOperationError("");
    const sequence = ++mutationSequenceRef.current;
    try {
      await api.createLifeHabit(habit);
      await refreshAfterMutation(sequence, today.day);
      if (sequence === mutationSequenceRef.current) setAnnouncement(`${habit.name} added.`);
      return true;
    } catch {
      if (sequence === mutationSequenceRef.current) {
        setOperationError(`${habit.name} was not added. Check the fields or use a different name.`);
        setAnnouncement(`${habit.name} was not added.`);
      }
      return false;
    } finally {
      addingHabitRef.current = false;
      mutationInFlightRef.current = false;
      setAddingHabit(false);
    }
  };

  const updateHabit = async (habit: LifeHabit, update: LifeHabitUpdate): Promise<boolean> => {
    if (!today) return false;
    const sequence = beginHabitMutation(habit.id);
    if (sequence === null) return false;
    try {
      await api.updateLifeHabit(habit.id, update);
      await refreshAfterMutation(sequence, today.day);
      if (sequence === mutationSequenceRef.current) setAnnouncement(`${habit.name} updated.`);
      return true;
    } catch {
      if (sequence === mutationSequenceRef.current) {
        setOperationError(`${habit.name} was not updated. Check the fields and try again.`);
        setAnnouncement(`${habit.name} was not updated.`);
      }
      return false;
    } finally {
      endHabitMutation(habit.id);
    }
  };

  const saveReflection = async (reflection: LifeReflectionUpdate) => {
    if (!today || mutationInFlightRef.current) return;
    mutationInFlightRef.current = true;
    const sequence = ++mutationSequenceRef.current;
    setSavingReflection(true);
    setOperationError("");
    try {
      await api.setLifeReflection(today.day, reflection);
      await refreshAfterMutation(sequence, today.day);
      if (sequence === mutationSequenceRef.current) setAnnouncement("Daily reflection saved.");
    } catch {
      if (sequence === mutationSequenceRef.current) {
        setOperationError("Daily reflection was not saved. Your text is still here; try again.");
        setAnnouncement("Daily reflection was not saved.");
      }
    } finally {
      mutationInFlightRef.current = false;
      setSavingReflection(false);
    }
  };

  return (
    <ProgressView
      state={state}
      today={today}
      history={history}
      error={error}
      announcement={announcement}
      operationError={operationError}
      pendingHabitIds={pendingHabitIds}
      addingHabit={addingHabit}
      savingReflection={savingReflection}
      onRetry={() => void load()}
      onIncrement={(habit) => void changeHabit(habit, 1)}
      onDecrement={(habit) => void changeHabit(habit, -1)}
      onAddHabit={addHabit}
      onUpdateHabit={updateHabit}
      onSaveReflection={(reflection) => void saveReflection(reflection)}
    />
  );
}
