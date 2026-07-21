import * as NodeOS from "node:os";

import { type ServerProviderSkill } from "@t3tools/contracts";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const CursorSkillFrontmatter = Schema.Struct({
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  "user-invocable": Schema.optional(Schema.Boolean),
});

const decodeCursorSkillFrontmatter = Schema.decodeUnknownEffect(fromYaml(CursorSkillFrontmatter));

interface CursorSkillRoot {
  readonly directory: string;
  readonly scope: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function extractFrontmatter(markdown: string): string | undefined {
  const match = /^---[\t ]*\r?\n([\s\S]*?)\r?\n---(?:[\t ]*\r?\n|[\t ]*$)/.exec(markdown);
  return match?.[1];
}

const readDirectoryOrEmpty = Effect.fn("CursorSkillDiscovery.readDirectoryOrEmpty")(function* (
  directory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem
    .readDirectory(directory, { recursive: false })
    .pipe(Effect.orElseSucceed(() => []));
});

const projectSkillRoots = Effect.fn("CursorSkillDiscovery.projectSkillRoots")(function* (
  cwd: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const roots: CursorSkillRoot[] = [];
  let current = path.resolve(cwd);

  while (true) {
    roots.push(
      { directory: path.join(current, ".cursor", "skills"), scope: "project" },
      { directory: path.join(current, ".agents", "skills"), scope: "project" },
    );

    const isRepositoryRoot = yield* fileSystem
      .exists(path.join(current, ".git"))
      .pipe(Effect.orElseSucceed(() => false));
    const parent = path.dirname(current);
    if (isRepositoryRoot || parent === current) {
      break;
    }
    current = parent;
  }

  return roots;
});

const pluginSkillRoots = Effect.fn("CursorSkillDiscovery.pluginSkillRoots")(function* (
  homeDirectory: string,
) {
  const path = yield* Path.Path;
  const cacheDirectory = path.join(homeDirectory, ".cursor", "plugins", "cache");
  const roots: CursorSkillRoot[] = [];

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
        });
      }
    }
  }

  return roots;
});

const readSkill = Effect.fn("CursorSkillDiscovery.readSkill")(function* (
  root: CursorSkillRoot,
  entryName: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillPath = path.join(root.directory, entryName, "SKILL.md");
  const markdown = yield* fileSystem
    .readFileString(skillPath)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (markdown === undefined) {
    return undefined;
  }

  const frontmatter = extractFrontmatter(markdown);
  if (frontmatter === undefined) {
    return undefined;
  }

  const parsed = yield* decodeCursorSkillFrontmatter(frontmatter).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  if (parsed === undefined || parsed["user-invocable"] === false) {
    return undefined;
  }

  const name = nonEmpty(parsed.name) ?? nonEmpty(entryName);
  if (!name) {
    return undefined;
  }
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
 * Cursor does not currently expose skill metadata through ACP. Mirror the
 * documented Cursor discovery roots so T3's provider-neutral skill picker can
 * still resolve skills for the active worktree. Roots are ordered by
 * specificity and duplicate names keep the first (highest-precedence) match.
 */
export const listCursorSkills = Effect.fn("listCursorSkills")(function* (input: {
  readonly cwd: string;
  readonly homeDirectory?: string;
}): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const homeDirectory = path.resolve(input.homeDirectory ?? NodeOS.homedir());
  const roots = [
    ...(yield* projectSkillRoots(input.cwd)),
    { directory: path.join(homeDirectory, ".cursor", "skills"), scope: "user" },
    { directory: path.join(homeDirectory, ".agents", "skills"), scope: "user" },
    ...(yield* pluginSkillRoots(homeDirectory)),
    { directory: path.join(homeDirectory, ".cursor", "skills-cursor"), scope: "bundled" },
  ] satisfies ReadonlyArray<CursorSkillRoot>;

  const skills: ServerProviderSkill[] = [];
  const seenNames = new Set<string>();
  for (const root of roots) {
    for (const entryName of (yield* readDirectoryOrEmpty(root.directory)).toSorted()) {
      const skill = yield* readSkill(root, entryName);
      if (!skill || seenNames.has(skill.name.toLowerCase())) {
        continue;
      }
      seenNames.add(skill.name.toLowerCase());
      skills.push(skill);
    }
  }

  return skills;
});
