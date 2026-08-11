import type { Skill, SkillRegistry } from "./types.ts";

export class InMemorySkillRegistry implements SkillRegistry {
  private skills = new Map<string, Skill>();

  register(skill: Skill): void {
    if (!skill.name || typeof skill.name !== "string") {
      throw new Error("Skill must have a non-empty string name");
    }
    if (this.skills.has(skill.name)) {
      // Allow re-registration to support hot-reload scenarios
      console.warn(`[skills] Overwriting existing skill: ${skill.name}`);
    }
    this.skills.set(skill.name, skill);
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  list(): Skill[] {
    return Array.from(this.skills.values());
  }

  resolve(names: string[]): Skill[] {
    const resolved: Skill[] = [];
    const seen = new Set<string>();

    for (const name of names) {
      if (seen.has(name)) continue;
      const skill = this.skills.get(name);
      if (skill) {
        resolved.push(skill);
        seen.add(name);
      } else {
        console.warn(`[skills] Skill not found: ${name}`);
      }
    }

    return resolved;
  }

  unregister(name: string): boolean {
    return this.skills.delete(name);
  }
}

/** Global default registry instance */
export const defaultSkillRegistry = new InMemorySkillRegistry();
