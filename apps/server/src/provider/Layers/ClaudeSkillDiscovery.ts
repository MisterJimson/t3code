import { type ServerProviderSkill } from "@t3tools/contracts";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const ClaudeSkillFrontmatter = Schema.Struct({
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  "user-invocable": Schema.optional(Schema.Boolean),
});

const decodeClaudeSkillFrontmatter = Schema.decodeUnknownEffect(fromYaml(ClaudeSkillFrontmatter));

interface ClaudeSkillRoot {
  readonly directory: string;
  readonly scope: string;
  readonly namespace?: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function extractFrontmatter(markdown: string): string | undefined {
  const match = /^---[\t ]*\r?\n([\s\S]*?)\r?\n---(?:[\t ]*\r?\n|[\t ]*$)/.exec(markdown);
  return match?.[1];
}

const readDirectoryOrEmpty = Effect.fn("ClaudeSkillDiscovery.readDirectoryOrEmpty")(function* (
  directory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem
    .readDirectory(directory, { recursive: false })
    .pipe(Effect.orElseSucceed(() => []));
});

const projectSkillRoots = Effect.fn("ClaudeSkillDiscovery.projectSkillRoots")(function* (
  cwd: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const roots: ClaudeSkillRoot[] = [];
  let current = path.resolve(cwd);

  while (true) {
    roots.push(
      { directory: path.join(current, ".claude", "skills"), scope: "project" },
      { directory: path.join(current, ".agents", "skills"), scope: "project" },
    );

    const isRepositoryRoot = yield* fileSystem
      .exists(path.join(current, ".git"))
      .pipe(Effect.orElseSucceed(() => false));
    const parent = path.dirname(current);
    if (isRepositoryRoot || parent === current) break;
    current = parent;
  }

  return roots;
});

const pluginSkillRoots = Effect.fn("ClaudeSkillDiscovery.pluginSkillRoots")(function* (
  configDirectory: string,
) {
  const path = yield* Path.Path;
  const cacheDirectory = path.join(configDirectory, "plugins", "cache");
  const roots: ClaudeSkillRoot[] = [];

  for (const marketplace of (yield* readDirectoryOrEmpty(cacheDirectory)).toSorted()) {
    const marketplaceDirectory = path.join(cacheDirectory, marketplace);
    for (const plugin of (yield* readDirectoryOrEmpty(marketplaceDirectory)).toSorted()) {
      const pluginDirectory = path.join(marketplaceDirectory, plugin);
      for (const version of (yield* readDirectoryOrEmpty(pluginDirectory))
        .toSorted()
        .toReversed()) {
        roots.push({
          directory: path.join(pluginDirectory, version, "skills"),
          scope: `plugin:${plugin}`,
          namespace: plugin,
        });
      }
    }
  }

  return roots;
});

const readSkill = Effect.fn("ClaudeSkillDiscovery.readSkill")(function* (
  root: ClaudeSkillRoot,
  entryName: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillPath = path.join(root.directory, entryName, "SKILL.md");
  const markdown = yield* fileSystem
    .readFileString(skillPath)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (markdown === undefined) return undefined;

  const frontmatter = extractFrontmatter(markdown);
  if (frontmatter === undefined) return undefined;
  const parsed = yield* decodeClaudeSkillFrontmatter(frontmatter).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  if (parsed === undefined || parsed["user-invocable"] === false) return undefined;

  const baseName = nonEmpty(parsed.name) ?? nonEmpty(entryName);
  if (!baseName) return undefined;
  const name =
    root.namespace && !baseName.includes(":") ? `${root.namespace}:${baseName}` : baseName;
  const description = nonEmpty(parsed.description);
  return {
    name,
    path: skillPath,
    scope: root.scope,
    enabled: true,
    ...(description ? { description } : {}),
  } satisfies ServerProviderSkill;
});

/**
 * Claude natively discovers `.claude/skills`, but T3 also presents shared
 * `.agents/skills` and installed plugin skills in its provider-neutral picker.
 */
export const listClaudeSkills = Effect.fn("listClaudeSkills")(function* (input: {
  readonly cwd: string;
  readonly configDirectory: string;
}): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const roots = [
    ...(yield* projectSkillRoots(input.cwd)),
    { directory: path.join(input.configDirectory, "skills"), scope: "user" },
    ...(yield* pluginSkillRoots(input.configDirectory)),
  ] satisfies ReadonlyArray<ClaudeSkillRoot>;

  const skills: ServerProviderSkill[] = [];
  const seenNames = new Set<string>();
  for (const root of roots) {
    for (const entryName of (yield* readDirectoryOrEmpty(root.directory)).toSorted()) {
      const skill = yield* readSkill(root, entryName);
      if (!skill || seenNames.has(skill.name.toLowerCase())) continue;
      seenNames.add(skill.name.toLowerCase());
      skills.push(skill);
    }
  }

  return skills;
});
