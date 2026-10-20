import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tegami } from "tegami"
import { runCli } from "tegami/cli"
import { github } from "tegami/plugins/github"
import { githubRelease } from "./github-release.mts"

const repository = process.env.GITHUB_REPOSITORY?.trim() || "SolZeroAI/grokcast"
const publishedPackageId = "npm:grokcast"

const release = tegami({
  conventionalCommits: false,
  npm: {
    client: "nub",
    updateLockFile: false,
  },
  plugins: [
    // github() opens the version pull request. The extension is private, so that
    // plugin does not publish to npm or create the release tag. githubRelease()
    // creates the GitHub release and the name@version tag from the publish lock.
    // The Raycast Store submission is a separate, manual step (see CONTRIBUTING.md).
    github({
      repo: repository,
      release: {
        eager: false,
        create({ pkg, plan }) {
          const sections = (plan.packages.get(pkg.id)?.changelogs ?? []).flatMap((entry) =>
            entry.sections.flatMap((section) => [`### ${section.title}`, "", section.content, ""]),
          )
          return {
            title: `Grokcast v${pkg.version}`,
            notes: sections.join("\n").trim(),
          }
        },
      },
      versionPr: {
        base: "master",
        branch: "tegami/version-packages",
      },
    }),
    {
      name: "root-version-file",
      async applyDraft(draft) {
        const pkg = this.graph.get(publishedPackageId)
        if (!pkg) return
        const nextVersion = draft.getPackageDraft(pkg.id)?.bumpVersion(pkg)
        if (!nextVersion) return
        await writeFile(join(this.cwd, "VERSION"), `${nextVersion}\n`)
      },
    },
    githubRelease(),
  ],
})

await runCli(release)
