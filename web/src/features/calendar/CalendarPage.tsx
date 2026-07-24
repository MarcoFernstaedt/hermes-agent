import { useEffect, useMemo, useState } from "react";
import { Button } from "@nous-research/ui/ui/components/button";
import { Input } from "@nous-research/ui/ui/components/input";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { ConfirmDialog } from "@nous-research/ui/ui/components/confirm-dialog";
import { Toast } from "@nous-research/ui/ui/components/toast";
import { useToast } from "@nous-research/ui/hooks/use-toast";
import {
  CalendarDays,
  Check,
  MapPin,
  Plus,
  RefreshCw,
  Trash2,
  Users,
} from "lucide-react";

import { usePageHeader } from "@/contexts/usePageHeader";
import { useIntent } from "@/hooks/useIntent";
import { api, type CalendarEvent } from "@/lib/api";
import { useData } from "@/lib/use-data";
import { cn } from "@/lib/utils";
import {
  agendaWindow,
  formatDayHeading,
  formatEventTime,
  groupByDay,
  isAllDay,
} from "./calendar-model";
import { NewEventDialog } from "./NewEventDialog";

export default function CalendarPage() {
  const { setTitle } = usePageHeader();
  useEffect(() => setTitle("Calendar"), [setTitle]);

  const { toast, showToast } = useToast();
  const [composing, setComposing] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<CalendarEvent | null>(null);
  const [newTask, setNewTask] = useState("");

  // Command-palette "New calendar event" opens the dialog after navigation.
  useIntent("calendar:new-event", () => setComposing(true));

  const win = useMemo(() => agendaWindow(14), []);
  const conn = useData("cal:connection", api.getCalendarConnection);
  const events = useData(
    conn.data?.connected ? "cal:events" : null,
    () => api.listCalendarEvents(win.min, win.max),
  );
  const tasks = useData(conn.data?.connected ? "cal:tasks" : null, () => api.listTasks(false));

  const days = useMemo(() => groupByDay(events.data?.items ?? []), [events.data]);
  const openTasks = (tasks.data?.items ?? []).filter((t) => t.status !== "completed");

  const refresh = () => {
    events.mutate();
    tasks.mutate();
  };

  const addTask = async () => {
    const title = newTask.trim();
    if (!title) return;
    setNewTask("");
    try {
      await api.createTask(title);
      tasks.mutate();
    } catch {
      showToast("Could not add task", "error");
    }
  };

  const completeTask = async (id: string) => {
    try {
      await api.completeTask(id);
      tasks.mutate();
    } catch {
      showToast("Could not complete task", "error");
    }
  };

  const deleteEvent = async () => {
    if (!pendingDelete) return;
    try {
      await api.deleteCalendarEvent(pendingDelete.id);
      showToast("Event deleted", "success");
      events.mutate();
    } catch {
      showToast("Could not delete event", "error");
    } finally {
      setPendingDelete(null);
    }
  };

  if (conn.isLoading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-text-secondary">
        <Spinner /> Checking calendar connection…
      </div>
    );
  }

  if (!conn.data?.connected || conn.data?.needs_reauth) {
    return (
      <div className="mx-auto max-w-md p-8 text-center" role="status">
        <CalendarDays className="mx-auto mb-3 size-8 text-text-tertiary" aria-hidden />
        <h1 className="text-lg font-semibold">
          {conn.data?.needs_reauth ? "Calendar needs reauthorization" : "Calendar not connected"}
        </h1>
        <p className="mt-2 text-sm text-text-secondary">
          Connect Google on the server to {conn.data?.needs_reauth ? "reconnect" : "use"} your calendar, then retry.
        </p>
        <Button className="mt-4" outlined prefix={<RefreshCw />} onClick={() => conn.mutate()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col gap-3 p-3 sm:p-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-display text-sm tracking-wider text-text-tertiary">Next 14 days</h1>
        <div className="flex items-center gap-2">
          <Button ghost size="icon" onClick={refresh} aria-label="Refresh" title="Refresh">
            <RefreshCw className={cn((events.isValidating || tasks.isValidating) && "animate-spin")} />
          </Button>
          <Button prefix={<Plus />} onClick={() => setComposing(true)}>
            New event
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {/* Tasks */}
        <section aria-label="Tasks" className="mb-4">
          <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-tertiary">
            Tasks
          </h2>
          <div className="flex items-center gap-2">
            <Input
              value={newTask}
              onChange={(e) => setNewTask(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void addTask()}
              placeholder="Add a task and press Enter"
              aria-label="New task"
            />
          </div>
          {openTasks.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1">
              {openTasks.map((t) => (
                <li key={t.id} className="flex items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => void completeTask(t.id)}
                    aria-label={`Complete: ${t.title}`}
                    className="grid size-5 shrink-0 place-items-center rounded-full border border-border text-transparent transition-colors hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
                  >
                    <Check className="size-3" />
                  </button>
                  <span className="min-w-0 flex-1 truncate text-sm">{t.title}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Agenda */}
        {events.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-text-secondary">
            <Spinner /> Loading events…
          </div>
        ) : days.length === 0 ? (
          <p className="py-8 text-center text-sm text-text-secondary">
            Nothing scheduled in the next 14 days.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {days.map((day) => {
              const heading = formatDayHeading(day.date);
              return (
                <section key={day.key} aria-label={`${heading.label}, ${heading.sub}`}>
                  <h2 className="sticky top-0 z-[1] flex items-baseline gap-2 bg-background-base/90 py-1 backdrop-blur">
                    <span className="text-sm font-semibold text-foreground">{heading.label}</span>
                    <span className="text-xs text-text-tertiary">{heading.sub}</span>
                  </h2>
                  <ul className="mt-1 flex flex-col gap-1.5">
                    {day.events.map((e) => (
                      <li key={e.id}>
                        <div
                          className={cn(
                            "group flex items-start gap-3 rounded-lg border border-border/60 bg-midground/[0.03] p-3",
                            "transition-colors hover:bg-midground/[0.06]",
                          )}
                        >
                          <div
                            aria-hidden
                            className={cn(
                              "mt-0.5 w-1 shrink-0 self-stretch rounded-full",
                              isAllDay(e) ? "bg-text-tertiary/40" : "bg-primary",
                            )}
                          />
                          <div className="min-w-0 flex-1">
                            <p className="font-mono text-xs text-text-secondary">
                              {formatEventTime(e)}
                            </p>
                            <p className="truncate text-sm font-medium">
                              {e.summary || "(no title)"}
                            </p>
                            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-text-tertiary">
                              {e.location && (
                                <span className="inline-flex items-center gap-1">
                                  <MapPin className="size-3" aria-hidden /> {e.location}
                                </span>
                              )}
                              {e.attendees && e.attendees.length > 0 && (
                                <span className="inline-flex items-center gap-1">
                                  <Users className="size-3" aria-hidden /> {e.attendees.length}
                                </span>
                              )}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => setPendingDelete(e)}
                            aria-label={`Delete event: ${e.summary || "(no title)"}`}
                            className="shrink-0 rounded p-1 text-text-tertiary opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40 group-hover:opacity-100"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </div>

      {composing && (
        <NewEventDialog onClose={() => setComposing(false)} onCreated={refresh} />
      )}
      <ConfirmDialog
        open={pendingDelete !== null}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void deleteEvent()}
        loading={false}
        destructive
        title="Delete event?"
        description={`Delete "${pendingDelete?.summary || "(no title)"}"? This can't be undone.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
      />
      <Toast toast={toast} />
    </div>
  );
}
