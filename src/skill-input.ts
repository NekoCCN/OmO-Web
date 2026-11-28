type Skill = { readonly name: string; readonly location: string; readonly content: string };
type SkillInput = { readonly skills: readonly Skill[]; readonly request: string };

const currentPrefix = 'The user explicitly invoked the "';
const requestStart = "\n\n<user-request>\n";
const requestEnd = "\n</user-request>";

/** Native's user-attributed transcript envelope, not a general tag or Markdown parser. */
export function parseSkillInput(text: string): SkillInput | undefined {
  if (!text.startsWith(currentPrefix)) {
    if (!text.startsWith("<skill name=")) return;
    const legacy = /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/u.exec(text);
    if (legacy) return {
      skills: [{ name: legacy[1], location: legacy[2], content: legacy[3] }],
      request: legacy[4] ?? "",
    };
    return;
  }

  const block = /The user explicitly invoked the "([^"]+)" skill\. Follow the instructions in <skill-instruction> as binding for this request, while respecting higher-priority instructions\.\n\n<skill-instruction name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill-instruction>/uy;
  const skills: Skill[] = [];
  let endOfSkills = 0;
  while (true) {
    block.lastIndex = endOfSkills;
    const match = block.exec(text);
    if (!match || match[1] !== match[2]) return;
    skills.push({ name: match[1], location: match[3], content: match[4] });
    endOfSkills = block.lastIndex;
    if (!text.startsWith(`\n\n${currentPrefix}`, endOfSkills)) break;
    endOfSkills += 2;
  }
  if (endOfSkills === text.length) return { skills, request: "" };
  const start = endOfSkills + requestStart.length;
  const end = text.length - requestEnd.length;
  if (start <= end && text.startsWith(requestStart, endOfSkills) && text.endsWith(requestEnd)) {
    return { skills, request: text.slice(start, end) };
  }
}

export function skillInputNames({ skills }: SkillInput): string {
  const names = skills.slice(0, 3).map(({ name }) => {
    const head = name.slice(0, 24).replace(/[\uD800-\uDBFF]$/u, "").replace(/\s+/gu, " ").trim();
    return name.length > 24 ? `${head}…` : head || "…";
  });
  if (skills.length > names.length) names.push(`+${skills.length - names.length}`);
  return names.join(" · ");
}

export function skillInputInstructions({ skills }: SkillInput): string {
  return skills.map(({ name, location, content }) => `${name} · ${location}\n\n${content}`).join("\n\n");
}
