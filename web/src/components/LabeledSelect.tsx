import { useLayoutEffect, useRef, type ComponentProps } from "react";
import { Select } from "@nous-research/ui/ui/components/select";

type LabeledSelectProps = ComponentProps<typeof Select> & { label: string };

/**
 * Wraps the design-system Select so its internal `role="combobox"` button
 * carries an accessible name.
 *
 * The vendored Select renders the selected option's text as the widget's
 * *value*, not its *name* — and a combobox takes its name from
 * `aria-label`/`aria-labelledby` only, never from content. The component
 * also doesn't forward `aria-label`, so screen readers otherwise announce
 * an unlabeled combobox. We set the label on the real combobox node after
 * render, keeping one fix for every select in the app instead of a
 * per-call-site workaround.
 */
export function LabeledSelect({ label, ...props }: LabeledSelectProps) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const combobox = ref.current?.querySelector('[role="combobox"]');
    if (combobox && combobox.getAttribute("aria-label") !== label) {
      combobox.setAttribute("aria-label", label);
    }
  });

  return (
    <div ref={ref} className="contents">
      <Select {...props} />
    </div>
  );
}
