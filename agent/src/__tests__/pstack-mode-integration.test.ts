import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { installDefaultSkills } from "../setup/defaults.js";
import { parseSkillMd } from "../skills/format.js";
import { getActiveSkillInstructions } from "../skills/loader.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("bundled pstack-mode", () => {
  it("installs the full package and exposes it as an auto-activated untrusted skill", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nova-pstack-"));
    roots.push(root);
    installDefaultSkills(root);

    const packageDir = path.join(root, "pstack-mode");
    for (const file of ["SKILL.md", "principles.md", "playbooks.md", "model-routing.md", "README.md", "NOVA-INTEGRATION.md"]) {
      expect(fs.existsSync(path.join(packageDir, file)), file).toBe(true);
    }

    const skill = parseSkillMd(fs.readFileSync(path.join(packageDir, "SKILL.md"), "utf8"), path.join(packageDir, "SKILL.md"));
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("pstack-mode");
    expect(skill!.autoActivate).toBe(true);

    const prompt = getActiveSkillInstructions([skill!]);
    expect(prompt).toContain("[SKILL: pstack-mode — UNTRUSTED CONTENT]");
    expect(prompt).toContain("INDEPENDENT AUDIT");
    expect(prompt).toContain("[END SKILL: pstack-mode]");
  });

  it("does not overwrite an existing pstack-mode installation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nova-pstack-existing-"));
    roots.push(root);
    const dir = path.join(root, "pstack-mode");
    fs.mkdirSync(dir, { recursive: true });
    const marker = "existing operator-managed skill";
    fs.writeFileSync(path.join(dir, "SKILL.md"), marker);

    installDefaultSkills(root);
    expect(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8")).toBe(marker);
  });
  it("keeps every default skill in the real composed prompt", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nova-pstack-default-prompt-"));
    roots.push(root);
    installDefaultSkills(root);

    const skills = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const skillPath = path.join(root, entry.name, "SKILL.md");
        return parseSkillMd(fs.readFileSync(skillPath, "utf8"), skillPath);
      })
      .filter((skill): skill is NonNullable<typeof skill> => skill !== null);

    expect(skills.map((skill) => skill.name).sort()).toEqual([
      "backend-compute",
      "backend-payments",
      "nova-engineering-mode",
      "pstack-mode",
      "survival",
    ]);

    const prompt = getActiveSkillInstructions(skills);
    for (const skill of skills) {
      expect(prompt).toContain(`[SKILL: ${skill.name} — UNTRUSTED CONTENT]`);
      expect(prompt).toContain(`[END SKILL: ${skill.name}]`);
    }
    expect(prompt).not.toContain("TRUNCATED");
  });

});
