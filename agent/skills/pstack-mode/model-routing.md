# pstack-mode — model/role routing (optional)

Entirely optional. It does not authorize spawning, delegation, role changes, or model selection. Use it only inside NOVA's existing hierarchy, department authority, worker permissions, workforce limits, and routing controls.

Only relevant if your agent runner can dispatch
different sub-tasks to different models or sub-agents. If you're running
as a single model with no sub-agent capability, delete this file — the
rest of pstack-mode doesn't depend on it.

The original pstack read a Cursor-specific rule file
(`~/.cursor/rules/pstack-models.mdc`) to map roles to model slugs. This
is the generic replacement: a plain table your agent (or you) can edit.
If a role has no model assigned, just use whatever model is currently
running — don't block on this file being filled in.

| Role                          | Suggested kind of model            | Model to use (fill in) |
|--------------------------------|-------------------------------------|-------------------------|
| Mechanical / precisely-specified code | fast, cheap model                | |
| Judgment calls, prose, review  | strongest reasoning model available | |
| Review panel (if running multiple reviewers) | 2–4 different models/model families | |

Guidance carried over from the original: don't route everything to the
strongest model by default — mechanical, precisely-specified code is
cheaper and just as reliable on a fast model, and saves your strongest
model's budget for the judgment calls that actually need it.
