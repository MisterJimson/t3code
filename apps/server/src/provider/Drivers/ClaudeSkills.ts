/**
 * ClaudeSkills — filesystem discovery of Claude Code skills for the `$` picker.
 *
 * Claude Code loads skills from `<config dir>/skills` (user scope), then
 * `<cwd>/.agents/skills` and `<cwd>/.claude/skills` (project scope), one
 * directory per skill with a `SKILL.md` carrying YAML frontmatter. Later roots
 * win on name collisions, so precedence is user, `.agents`, then `.claude`.
 * The Agent SDK init handshake surfaces skills only as slash commands without
 * their filesystem paths, so the provider snapshot scans the same locations
 * directly, mirroring how the Codex app-server reports its skills.
 *
 * @module provider/Drivers/ClaudeSkills
 */
import * as NodeOS from "node:os";

import type { ClaudeSettings, ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

import { expandHomePath } from "../../pathExpansion.ts";

interface ClaudeSkillRoot {
  readonly directory: string;
  readonly scope: string;
  readonly namespace?: string;
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

type SkillFrontmatter =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | {
      readonly kind: "parsed";
      readonly name?: string;
      readonly description?: string;
      readonly userInvocable?: boolean;
    };

function parseSkillFrontmatter(contents: string): SkillFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    return { kind: "missing" };
  }

  let parsed: unknown;
  try {
    parsed = parseYamlDocument(match[1] ?? "");
  } catch {
    return { kind: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "malformed" };
  }

  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  const userInvocable =
    typeof record["user-invocable"] === "boolean" ? record["user-invocable"] : undefined;
  return {
    kind: "parsed",
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(userInvocable !== undefined ? { userInvocable } : {}),
  };
}

const readDirectoryOrEmpty = Effect.fn("ClaudeSkills.readDirectoryOrEmpty")(function* (
  directory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem
    .readDirectory(directory)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
});

const discoverProjectSkillRoots = Effect.fn("ClaudeSkills.discoverProjectSkillRoots")(function* (
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

  return roots.toReversed();
});

const discoverPluginSkillRoots = Effect.fn("ClaudeSkills.discoverPluginSkillRoots")(function* (
  configDirectory: string,
) {
  const path = yield* Path.Path;
  const cacheDirectory = path.join(configDirectory, "plugins", "cache");
  const roots: ClaudeSkillRoot[] = [];

  for (const marketplace of (yield* readDirectoryOrEmpty(cacheDirectory)).toSorted()) {
    const marketplaceDirectory = path.join(cacheDirectory, marketplace);
    for (const plugin of (yield* readDirectoryOrEmpty(marketplaceDirectory)).toSorted()) {
      const pluginDirectory = path.join(marketplaceDirectory, plugin);
      const version = (yield* readDirectoryOrEmpty(pluginDirectory)).toSorted().toReversed()[0];
      if (!version) continue;
      roots.push({
        directory: path.join(pluginDirectory, version, "skills"),
        scope: `plugin:${plugin}`,
        namespace: plugin,
      });
    }
  }

  return roots;
});

/**
 * Resolve the Claude config directory the CLI would use, matching the
 * precedence the spawned CLI sees: the instance's `homePath` (exported as
 * `CLAUDE_CONFIG_DIR` by `makeClaudeEnvironment`), then a `CLAUDE_CONFIG_DIR`
 * already present in the process environment, then `~/.claude`.
 */
const resolveClaudeConfigDirPath = Effect.fn("resolveClaudeConfigDirPath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath));
  }
  // No tilde expansion here: the spawned CLI receives this env var verbatim
  // (env vars are never shell-expanded), so a literal `~` must stay literal
  // for discovery to scan the same directory the runtime would. A relative
  // value is resolved against the workspace cwd — the subprocess's own cwd —
  // for the same reason.
  const environmentConfigDir = environment.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (environmentConfigDir.length > 0) {
    return cwd ? path.resolve(cwd, environmentConfigDir) : path.resolve(environmentConfigDir);
  }
  return path.join(NodeOS.homedir(), ".claude");
});

/**
 * Enumerate Claude Code skills from the user config dir, workspace
 * `.agents/skills`, and workspace `.claude/skills`, in that order. Discovery
 * is best-effort: unreadable roots and malformed skill entries are skipped so
 * a broken skill never degrades the provider snapshot. On name collisions,
 * later roots win: `.agents` beats user and `.claude` beats `.agents`, matching
 * Claude Code's resolution.
 */
export const discoverClaudeSkills = Effect.fn("discoverClaudeSkills")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDirPath = yield* resolveClaudeConfigDirPath(config, environment ?? process.env, cwd);

  const roots: ReadonlyArray<ClaudeSkillRoot> = [
    { directory: path.join(configDirPath, "skills"), scope: "user" },
    ...(yield* discoverPluginSkillRoots(configDirPath)),
    ...(cwd ? yield* discoverProjectSkillRoots(cwd) : []),
  ];

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const root of roots) {
    const entries = yield* readDirectoryOrEmpty(root.directory);

    for (const entry of [...entries].sort()) {
      const skillPath = path.join(root.directory, entry, "SKILL.md");
      const contents = yield* fileSystem
        .readFileString(skillPath)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (contents === undefined) {
        continue;
      }

      const frontmatter = parseSkillFrontmatter(contents);
      // Malformed frontmatter means the skill won't load in Claude Code
      // either — skip it rather than surfacing a broken entry under its
      // directory name.
      if (frontmatter.kind === "malformed") {
        continue;
      }
      if (frontmatter.kind === "parsed" && frontmatter.userInvocable === false) {
        continue;
      }

      const baseName =
        (frontmatter.kind === "parsed" ? frontmatter.name : undefined) ?? entry.trim();
      if (!baseName) {
        continue;
      }
      const name =
        root.namespace && !baseName.includes(":") ? `${root.namespace}:${baseName}` : baseName;

      skillsByName.set(name, {
        name,
        path: skillPath,
        enabled: true,
        scope: root.scope,
        ...(frontmatter.kind === "parsed" && frontmatter.description
          ? { description: frontmatter.description }
          : {}),
      });
    }
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});
