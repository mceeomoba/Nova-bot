# PStack integration in NOVA

## Location and discovery

The methodology lives in `agent/skills/pstack-mode/`. NOVA setup copies the complete directory to `<skillsDir>/pstack-mode` for a new installation. The existing skill loader scans `<skillsDir>/*/SKILL.md` at startup and on each loop, then injects enabled auto-activate skills into the prompt inside NOVA's untrusted-skill boundary. Existing installed copies are not overwritten.

`pstack-mode` applies to engineering work: features, fixes, refactors, debugging, tests, reliability, reviews, root-cause analysis, and release preparation. It complements NOVA Engineering Mode. PStack supplies methodology and task playbooks; NOVA Engineering Mode owns native gate planning and execution.

## Governance

PStack is process guidance, not authority. NOVA's constitution, CEO/root authority, hierarchy, department and worker permissions, security policy, independent audit, release gates, data and credential limits, spending controls, customer-contact controls, and safety rules remain authoritative. The loader keeps the skill inside its `UNTRUSTED CONTENT` markers.

`BUILD COMPLETE`, `TEST PASS`, `SECURITY REVIEW`, `INDEPENDENT AUDIT`, and `RELEASE APPROVAL` are distinct states. Builder tests do not constitute independent audit. Audit-integrity or validation-bypass defects block the next wave until an independent re-audit passes.

## Package conflicts resolved

- The generic package's "standing mode" wording is implemented as NOVA `auto-activate`; it creates no authority or permission.
- Its "do not block on the human unless irreversible" guidance is narrowed to ordinary implementation choices already authorized by NOVA.
- Its shipping playbook is subordinated to NOVA's independent-audit and release-approval gates.
- Optional model/sub-agent routing is limited by NOVA hierarchy, workforce, and worker-permission controls.

The package has no scripts, executables, dependencies, or configuration changes. `README.md`, `principles.md`, `playbooks.md`, and `model-routing.md` remain beside `SKILL.md` so agents can follow its intended references.
