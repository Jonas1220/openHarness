import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.ts';
import type { Tool } from './types.ts';

export interface Skill {
  name: string;
  description: string;
  dir: string;
  file: string;
}

/**
 * Skills follow the Agent Skills format used by Claude Code and Codex: a folder with a
 * SKILL.md whose frontmatter has `name` and `description`. Only names and descriptions go
 * into the system prompt; the model loads a skill's full instructions with `load_skill`.
 */
export function skillDirs(cwd: string): string[] {
  const home = os.homedir();
  return [
    path.join(home, '.openharness', 'skills'),
    path.join(home, '.agents', 'skills'),
    path.join(home, '.claude', 'skills'),
    path.join(cwd, '.agents', 'skills'),
    path.join(cwd, '.claude', 'skills'),
    path.join(cwd, '.openharness', 'skills'),
  ];
}

export async function loadSkills(cwd: string): Promise<Skill[]> {
  const byName = new Map<string, Skill>();
  for (const dir of skillDirs(cwd)) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const file = path.join(dir, e.name, 'SKILL.md');
      const text = await fs.readFile(file, 'utf8').catch(() => null);
      if (!text) continue;
      const { data } = parseFrontmatter(text);
      const name = data.name || e.name;
      byName.set(name, { name, description: (data.description || '').slice(0, 300), dir: path.join(dir, e.name), file });
    }
  }
  return [...byName.values()];
}

export function skillsPrompt(skills: Skill[]): string {
  if (!skills.length) return '';
  return `# Skills
Skills are packaged instructions for specific tasks. When a task matches a skill's description, call load_skill with its name before starting, then follow its instructions.

${skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')}`;
}

export function loadSkillTool(skills: Skill[]): Tool {
  return {
    name: 'load_skill',
    kind: 'read',
    description: 'Load the full instructions of a skill listed in the system prompt.',
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'Skill name.' } }, required: ['name'] },
    describe: (a) => `Load skill ${a.name}`,
    async run(args) {
      const skill = skills.find((s) => s.name === args.name);
      if (!skill) return { output: `No skill named "${args.name}". Available: ${skills.map((s) => s.name).join(', ')}`, isError: true };
      const { body } = parseFrontmatter(await fs.readFile(skill.file, 'utf8'));
      return { output: `Skill "${skill.name}" (files in ${skill.dir}):\n\n${body.trim()}` };
    },
  };
}
