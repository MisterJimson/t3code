import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { listCursorSkills } from "./CursorSkillDiscovery.ts";

const writeSkill = Effect.fn("CursorSkillDiscovery.test.writeSkill")(function* (input: {
  readonly root: string;
  readonly directoryName: string;
  readonly frontmatter: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(input.root, input.directoryName);
  yield* fileSystem.makeDirectory(directory, { recursive: true });
  yield* fileSystem.writeFileString(
    path.join(directory, "SKILL.md"),
    `---\n${input.frontmatter}\n---\n\nInstructions\n`,
  );
});

it.layer(NodeServices.layer)("listCursorSkills", (it) => {
  it.effect("discovers worktree and user skills with project precedence", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sandbox = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-cursor-skills-",
        });
        const home = path.join(sandbox, "home");
        const repo = path.join(sandbox, "repo");
        const packageDirectory = path.join(repo, "packages", "web");
        yield* fileSystem.makeDirectory(path.join(repo, ".git"), { recursive: true });
        yield* fileSystem.makeDirectory(packageDirectory, { recursive: true });

        yield* writeSkill({
          root: path.join(home, ".cursor", "skills"),
          directoryName: "review",
          frontmatter: "name: review\ndescription: User review",
        });
        yield* writeSkill({
          root: path.join(repo, ".agents", "skills"),
          directoryName: "review",
          frontmatter: "name: review\ndescription: Project review",
        });
        yield* writeSkill({
          root: path.join(packageDirectory, ".cursor", "skills"),
          directoryName: "package-check",
          frontmatter: "description: Check this package",
        });
        yield* writeSkill({
          root: path.join(repo, ".cursor", "skills"),
          directoryName: "hidden",
          frontmatter: "name: hidden\ndescription: Hidden\nuser-invocable: false",
        });

        const skills = yield* listCursorSkills({ cwd: packageDirectory, homeDirectory: home });

        assert.deepStrictEqual(
          skills.map((skill) => ({
            name: skill.name,
            description: skill.description,
            scope: skill.scope,
          })),
          [
            { name: "package-check", description: "Check this package", scope: "project" },
            { name: "review", description: "Project review", scope: "project" },
          ],
        );
      }),
    ),
  );

  it.effect("discovers installed plugin and bundled skills while skipping malformed files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sandbox = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-cursor-plugin-skills-",
        });
        const home = path.join(sandbox, "home");
        const repo = path.join(sandbox, "repo");
        yield* fileSystem.makeDirectory(path.join(repo, ".git"), { recursive: true });

        yield* writeSkill({
          root: path.join(
            home,
            ".cursor",
            "plugins",
            "cache",
            "terminal-ai-plugins",
            "engineering",
            "version-a",
            "skills",
          ),
          directoryName: "review",
          frontmatter: "name: engineering:review\ndescription: Review changes",
        });
        yield* writeSkill({
          root: path.join(
            home,
            ".cursor",
            "plugins",
            "cache",
            "terminal-ai-plugins",
            "engineering",
            "version-a",
            "skills",
          ),
          directoryName: "poteto-mode",
          frontmatter: "name: Poteto Mode\ndescription: Work in Poteto's style",
        });
        yield* writeSkill({
          root: path.join(home, ".cursor", "skills-cursor"),
          directoryName: "browser",
          frontmatter: "name: browser\ndescription: Browse the web",
        });
        const malformedDirectory = path.join(repo, ".agents", "skills", "broken");
        yield* fileSystem.makeDirectory(malformedDirectory, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(malformedDirectory, "SKILL.md"),
          "not frontmatter",
        );

        const skills = yield* listCursorSkills({ cwd: repo, homeDirectory: home });

        assert.deepStrictEqual(
          skills.map((skill) => ({
            name: skill.name,
            displayName: skill.displayName,
            scope: skill.scope,
          })),
          [
            {
              name: "poteto-mode",
              displayName: "Poteto Mode",
              scope: "plugin:engineering",
            },
            {
              name: "engineering:review",
              displayName: undefined,
              scope: "plugin:engineering",
            },
            { name: "browser", displayName: undefined, scope: "bundled" },
          ],
        );
      }),
    ),
  );
});
