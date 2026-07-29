import { useState } from "react";
import { Button } from "@nous-research/ui/ui/components/button";
import { Input } from "@nous-research/ui/ui/components/input";
import { Switch } from "@nous-research/ui/ui/components/switch";
import { X } from "lucide-react";

import { api, type CalendarEventBody } from "@/lib/api";

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** Compact create-event dialog. Times are composed in the local zone and the
 *  IANA zone is sent so the event lands correctly and survives DST. */
export function NewEventDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [summary, setSummary] = useState("");
  const [date, setDate] = useState(today);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("09:30");
  const [allDay, setAllDay] = useState(false);
  const [location, setLocation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!summary.trim()) {
      setError("Give the event a title.");
      return;
    }
    setBusy(true);
    setError(null);
    const body: CalendarEventBody = allDay
      ? {
          summary,
          start: date,
          end: new Date(new Date(date).getTime() + 86400000).toISOString().slice(0, 10),
          all_day: true,
          location: location || undefined,
        }
      : {
          summary,
          start: `${date}T${start}:00`,
          end: `${date}T${end}:00`,
          timezone: TZ,
          location: location || undefined,
        };
    try {
      await api.createCalendarEvent(body);
      onCreated();
      onClose();
    } catch {
      setError("Could not create the event.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[90] flex items-end justify-center bg-black/50 backdrop-blur-[2px] sm:items-center sm:p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="New event"
        className="w-full max-w-md rounded-t-xl border border-border bg-background-base p-4 shadow-xl sm:rounded-xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">New event</h2>
          <Button ghost size="icon" onClick={onClose} aria-label="Close">
            <X />
          </Button>
        </div>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-text-secondary">Title</span>
            <Input value={summary} onChange={(e) => setSummary(e.target.value)} autoFocus aria-label="Event title" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-text-secondary">Date</span>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
          </label>
          {!allDay && (
            <div className="flex gap-3">
              <label className="flex flex-1 flex-col gap-1 text-sm">
                <span className="text-text-secondary">Start</span>
                <Input type="time" value={start} onChange={(e) => setStart(e.target.value)} aria-label="Start time" />
              </label>
              <label className="flex flex-1 flex-col gap-1 text-sm">
                <span className="text-text-secondary">End</span>
                <Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} aria-label="End time" />
              </label>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-sm text-text-secondary">All day</span>
            <Switch checked={allDay} onCheckedChange={setAllDay} aria-label="All day" />
          </div>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-text-secondary">Location (optional)</span>
            <Input value={location} onChange={(e) => setLocation(e.target.value)} aria-label="Location" />
          </label>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}

          <div className="mt-1 flex justify-end gap-2">
            <Button outlined onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void submit()} disabled={busy}>
              Create event
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
