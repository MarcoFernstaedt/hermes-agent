import { useForm, type SubmitHandler } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@nous-research/ui/ui/components/button";

import { cn } from "@/lib/utils";
import type { FieldDef } from "./fields";
import { buildDefaults, buildZodSchema } from "./form-schema";

/**
 * FormFromSchema — the edit surface generated from a capability's FieldDef[],
 * the write counterpart to FieldGrid. React Hook Form + a Zod schema (built by
 * form-schema.ts) give per-field validation from the same declaration. The
 * field-type → input mapping is a closed set (text, number, currency, date,
 * select, boolean, url, markdown, tags); an unknown type falls back to text so
 * a new type degrades rather than breaks.
 */
export function FormFromSchema<T extends Record<string, unknown>>({
  fields,
  initial,
  onSubmit,
  onCancel,
  submitLabel = "Save",
  className,
}: {
  fields: FieldDef[];
  initial?: Partial<T>;
  onSubmit: (values: Record<string, unknown>) => void;
  onCancel?: () => void;
  submitLabel?: string;
  className?: string;
}) {
  const schema = buildZodSchema(fields);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm({
    // zod 3.25 ships both the classic and next-gen type surfaces; the resolver's
    // overload resolves to the latter, so bridge the (runtime-correct) schema.
    resolver: zodResolver(
      schema as unknown as Parameters<typeof zodResolver>[0],
    ),
    defaultValues: buildDefaults(fields, initial as Record<string, unknown>),
  });

  const submit: SubmitHandler<Record<string, unknown>> = (values) => {
    onSubmit(values);
  };

  return (
    <form
      onSubmit={handleSubmit(submit)}
      className={cn("flex flex-col gap-3", className)}
      noValidate
    >
      {fields.map((field) => {
        const error = errors[field.name]?.message as string | undefined;
        return (
          <div key={field.name} className="flex flex-col gap-1">
            {field.type !== "boolean" && (
              <label
                htmlFor={`field-${field.name}`}
                className="text-xs font-medium uppercase tracking-wide text-text-secondary"
              >
                {field.label}
                {field.required && <span className="ml-0.5 text-destructive">*</span>}
              </label>
            )}
            <FieldInput field={field} register={register} />
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
        );
      })}

      <div className="mt-1 flex items-center justify-end gap-2">
        {onCancel && (
          <Button type="button" outlined onClick={onCancel} disabled={isSubmitting}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={isSubmitting}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

const INPUT_CN =
  "w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:ring-1 focus-visible:ring-primary/40";

function FieldInput({
  field,
  register,
}: {
  field: FieldDef;
  register: ReturnType<typeof useForm>["register"];
}) {
  const id = `field-${field.name}`;
  const common = {
    id,
    disabled: field.readOnly,
    ...register(field.name),
  };
  const ph = field.placeholder;

  switch (field.type) {
    case "boolean":
      return (
        <label htmlFor={id} className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-[var(--imperator-gold,#e8c87a)]"
            {...common}
          />
          {field.label}
        </label>
      );
    case "select":
      return (
        <select className={INPUT_CN} {...common}>
          <option value="">Select…</option>
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case "markdown":
      return <textarea rows={4} placeholder={ph} className={cn(INPUT_CN, "resize-y font-mono")} {...common} />;
    case "number":
    case "currency":
      return <input type="number" step="any" placeholder={ph} className={INPUT_CN} {...common} />;
    case "date":
      return <input type="date" className={INPUT_CN} {...common} />;
    case "url":
      return <input type="url" placeholder={ph} className={INPUT_CN} {...common} />;
    case "tags":
      return <input type="text" placeholder={ph ?? "comma, separated"} className={INPUT_CN} {...common} />;
    default:
      return <input type="text" placeholder={ph} className={INPUT_CN} {...common} />;
  }
}
