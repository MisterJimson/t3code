import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { listClaudeSkills } from "./ClaudeSkillDiscovery.ts";

const writeSkill = Effect.fn("ClaudeSkillDiscovery.test.writeSkill")(function* (input: {
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

it.layer(NodeServices.layer)("listClaudeSkills", (it) => {
  it.effect("discovers native, shared, user, and plugin skills with project precedence", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sandbox = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-claude-skills-",
        });
        const configDirectory = path.join(sandbox, "claude-config");
        const repo = path.join(sandbox, "repo");
        const packageDirectory = path.join(repo, "packages", "web");
        yield* fileSystem.makeDirectory(path.join(repo, ".git"), { recursive: true });
        yield* fileSystem.makeDirectory(packageDirectory, { recursive: true });

        yield* writeSkill({
          root: path.join(configDirectory, "skills"),
          directoryName: "review",
          frontmatter: "name: review\ndescription: User review",
        });
        yield* writeSkill({
          root: path.join(repo, ".agents", "skills"),
          directoryName: "review",
          frontmatter: "name: review\ndescription: Shared project review",
        });
        yield* writeSkill({
          root: path.join(packageDirectory, ".claude", "skills"),
          directoryName: "native",
          frontmatter: "description: Native Claude skill",
        });
        yield* writeSkill({
          root: path.join(
            configDirectory,
            "plugins",
            "cache",
            "terminal-ai-plugins",
            "engineering",
            "1.0.0",
            "skills",
          ),
          directoryName: "triage",
          frontmatter: "name: triage\ndescription: Triage a bug",
        });

        const skills = yield* listClaudeSkills({ cwd: packageDirectory, configDirectory });

        assert.deepStrictEqual(
          skills.map((skill) => ({
            name: skill.name,
            description: skill.description,
            scope: skill.scope,
          })),
          [
            { name: "native", description: "Native Claude skill", scope: "project" },
            { name: "review", description: "Shared project review", scope: "project" },
            {
              name: "engineering:triage",
              description: "Triage a bug",
              scope: "plugin:engineering",
            },
          ],
        );
      }),
    ),
  );
});
