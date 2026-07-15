/**
 * Display-level rebrand for backend-supplied copy (skill/plugin/channel/
 * config/env descriptions arrive from the Python side still saying
 * "Hermes"). Case-sensitive word replace so lowercase CLI commands
 * (`hermes update`, `hermes plugins enable …`), env keys (HERMES_*), and
 * identifiers pass through untouched.
 */
export function imperatorBrand(text: string): string {
  return text
    .replace(/(?<![A-Za-z0-9_$])Hermes Agent(?![A-Za-z0-9_$])/g, "Imperator")
    .replace(/(?<![A-Za-z0-9_$])Hermes(?![A-Za-z0-9_$])/g, "Imperator");
}

export function imperatorThemeLabel(label: string): string {
  return label.replace(/Hermes/gi, "Imperator");
}
