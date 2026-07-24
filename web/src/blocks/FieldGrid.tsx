import { cn } from "@/lib/utils";
import { formatField, type FieldDef } from "./fields";

/**
 * FieldGrid — a read surface for a record's fields, rendered from the same
 * FieldDef[] the edit form uses. Label/value pairs in a responsive two-column
 * grid; a field may override rendering via `render`. Values format by declared
 * type (currency, date, boolean, tags) so a generated record looks intentional.
 */
export function FieldGrid<T>({
  fields,
  record,
  columns = 2,
  className,
}: {
  fields: FieldDef<T>[];
  record: T;
  columns?: 1 | 2;
  className?: string;
}) {
  const values = record as Record<string, unknown>;
  return (
    <dl
      className={cn(
        "grid gap-x-6 gap-y-3",
        columns === 2 ? "sm:grid-cols-2" : "grid-cols-1",
        className,
      )}
    >
      {fields.map((field) => (
        <div key={field.name} className="min-w-0">
          <dt className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
            {field.label}
          </dt>
          <dd className="mt-0.5 truncate text-sm text-foreground">
            {field.render
              ? field.render(record)
              : formatField(field.type, values[field.name])}
          </dd>
        </div>
      ))}
    </dl>
  );
}
