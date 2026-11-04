// Publish to the Raycast Store from a staging folder that holds only what the Store needs.
//
// `ray publish` replaces `extensions/grokcast` in raycast/extensions with a copy of the
// folder it runs in. It skips only a fixed list (.git, .github, node_modules, Swift build
// folders) and reads no ignore file. So this script copies the Store files to
// `.store/grokcast`, removes what only this repository uses, and runs Raycast's CLI there.
//
//   nub run store:check     build the staging folder, then `ray build`, `ray lint`, and list its files
//   nub run store:publish   build the staging folder, then `ray publish` (opens or updates the Store PR)

import { spawn } from "node:child_process"
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import * as Arr from "effect/Array"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Match from "effect/Match"
import * as Schema from "effect/Schema"

const ROOT = join(import.meta.dirname, "..")

/** Git-ignored. `ray publish` names the Store folder after the extension, not this folder. */
const STAGE = join(ROOT, ".store", "grokcast")

/** What the Store runs, builds, or shows. Everything else stays in this repository. */
const STORE_FILES = [
  "src",
  "assets",
  "metadata",
  "recorder",
  "package-lock.json",
  "README.md",
  "CHANGELOG.md",
  "tsconfig.json",
  ".prettierrc.json",
  ".gitignore",
]

/** Build output that `ray build` makes again. */
const BUILD_OUTPUT = new Set([
  ".build",
  ".swiftpm",
  ".raycast-swift-build",
  "Package.resolved",
  "compiled_raycast_swift",
])

/** Tegami owns `version` here. The Store manages versions itself and does not want one. */
const REPO_ONLY_FIELDS = ["version"]

/**
 * Dev dependencies that `ray build` and `ray lint` use. The lint, format, test, and release
 * tools stay in this repository: the Store does not run them, and the lockfile nub writes
 * for their platform binaries fails `npm ci` on npm 10.
 */
const STORE_DEV_DEPENDENCIES = ["@types/node", "@types/react", "@types/ws", "typescript"]

/** Raycast's Store CI runs `npm ci` on Node 22, which comes with npm 10. */
const STORE_NPM = "npm@10"

/** Where `store:check` runs `npm ci` like the Store CI, away from the linked node_modules. */
const INSTALL_CHECK = join(ROOT, ".store", "install-check")

/**
 * The Store copy gets Raycast's standard scripts. This repository's scripts use the tests,
 * lint config, Tegami, and lefthook, which stay here.
 */
const STORE_SCRIPTS = {
  build: "ray build",
  dev: "ray develop",
  "fix-lint": "ray lint --fix",
  lint: "ray lint",
  publish: "npx @raycast/api@latest publish",
}

class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  message: Schema.String,
}) {}

const Manifest = Schema.Record(Schema.String, Schema.Unknown)
const Dependencies = Schema.Record(Schema.String, Schema.String)

type Mode = Data.TaggedEnum<{ Check: {}; Publish: {} }>

const Mode = Data.taggedEnum<Mode>()

const fileCall = <A,>(message: string, call: () => Promise<A>) =>
  Effect.tryPromise({ try: call, catch: () => new StoreError({ message }) })

/** Run a command, by default in the staging folder, with the terminal attached so sign-in prompts work. */
const run = Effect.fn("store.run")(function* (command: string, args: ReadonlyArray<string>, cwd: string = STAGE) {
  const code = yield* Effect.callback<number | null, StoreError>((resume) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" })

    child.on("error", () => resume(Effect.fail(new StoreError({ message: `Could not start ${command}.` }))))
    child.on("exit", (exit) => resume(Effect.succeed(exit)))
  })

  yield* Effect.filterOrFail(
    Effect.succeed(code),
    (exit) => exit === 0,
    () => new StoreError({ message: `${command} ${args.join(" ")} failed.` }),
  )
})

/** package.json without what only this repository uses, indented like the original. */
const storeManifest = Effect.fn("store.manifest")(function* () {
  const text = yield* fileCall("Could not read package.json.", () => readFile(join(ROOT, "package.json"), "utf8"))

  const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))(text).pipe(
    Effect.mapError(() => new StoreError({ message: "package.json is not valid JSON." })),
  )

  const devDependencies = yield* Schema.decodeUnknownEffect(Dependencies)(manifest["devDependencies"] ?? {}).pipe(
    Effect.mapError(() => new StoreError({ message: "package.json has devDependencies that are not strings." })),
  )

  const kept = Object.entries(manifest).filter(([field]) => !REPO_ONLY_FIELDS.includes(field))
  const storeDevDependencies = Object.entries(devDependencies).filter(([name]) => STORE_DEV_DEPENDENCIES.includes(name))

  return JSON.stringify(
    { ...Object.fromEntries(kept), scripts: STORE_SCRIPTS, devDependencies: Object.fromEntries(storeDevDependencies) },
    null,
    2,
  )
})

const copyStoreFile = (name: string) =>
  fileCall(`Could not copy ${name}.`, () =>
    cp(join(ROOT, name), join(STAGE, name), {
      recursive: true,
      filter: (source) =>
        !relative(ROOT, source)
          .split("/")
          .some((part) => BUILD_OUTPUT.has(part)),
    }),
  )

/**
 * The staging folder is its own git repository. After the Store merges a version,
 * `ray publish` copies the Store's folder over this one and uses git to look for edits
 * that other people made there.
 */
const commitStage = Effect.fn("store.commit")(function* () {
  yield* run("git", ["init", "--quiet"])
  // The node_modules link is a file, which the `node_modules/` ignore pattern misses.
  yield* fileCall("Could not write the git excludes.", () =>
    writeFile(join(STAGE, ".git", "info", "exclude"), "node_modules\n"),
  )
  yield* run("git", ["add", "--all"])
  yield* run("git", [
    "-c",
    "user.name=Grokcast Store",
    "-c",
    "user.email=store@grokcast.invalid",
    "commit",
    "--quiet",
    "--message",
    "Grokcast for the Raycast Store",
  ])
})

const stage = Effect.fn("store.stage")(function* () {
  yield* fileCall("Could not clear the staging folder.", () => rm(STAGE, { recursive: true, force: true }))
  yield* fileCall("Could not make the staging folder.", () => mkdir(STAGE, { recursive: true }))
  yield* Effect.forEach(STORE_FILES, copyStoreFile, { discard: true })
  const manifest = yield* storeManifest()
  yield* fileCall("Could not write package.json.", () => writeFile(join(STAGE, "package.json"), `${manifest}\n`))
  // npm drops the removed tools from the lockfile and keeps every other version as it is.
  yield* run("npx", [
    "--yes",
    STORE_NPM,
    "install",
    "--package-lock-only",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ])
  // `ray publish` skips node_modules, so the link only lets Raycast's CLI build here.
  yield* fileCall("Could not link node_modules.", () =>
    symlink(join(ROOT, "node_modules"), join(STAGE, "node_modules"), "dir"),
  )
  yield* commitStage()
})

/** Install the Store copy's lockfile the way the Store CI does. */
const installCheck = Effect.fn("store.installCheck")(function* () {
  yield* fileCall("Could not clear the install check folder.", () =>
    rm(INSTALL_CHECK, { recursive: true, force: true }),
  )
  yield* fileCall("Could not make the install check folder.", () => mkdir(INSTALL_CHECK, { recursive: true }))
  yield* Effect.forEach(
    ["package.json", "package-lock.json"],
    (name) => fileCall(`Could not copy ${name}.`, () => cp(join(STAGE, name), join(INSTALL_CHECK, name))),
    { discard: true },
  )
  yield* run("npx", ["--yes", STORE_NPM, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], INSTALL_CHECK)
  yield* fileCall("Could not clear the install check folder.", () =>
    rm(INSTALL_CHECK, { recursive: true, force: true }),
  )
})

const check = Effect.fn("store.check")(function* () {
  yield* installCheck()
  // --non-interactive lets the same check run in CI.
  yield* run("npx", ["ray", "build", "--non-interactive"])
  yield* run("npx", ["ray", "lint", "--non-interactive"])
  yield* run("git", ["ls-files"])
})

const publish = Effect.fn("store.publish")(function* () {
  yield* run("npx", ["@raycast/api@latest", "publish"])
})

const mode = Arr.contains(process.argv, "--publish") ? Mode.Publish() : Mode.Check()

const program = stage().pipe(
  Effect.andThen(Match.value(mode).pipe(Match.tag("Check", check), Match.tag("Publish", publish), Match.exhaustive)),
  Effect.catchTag("StoreError", (error) =>
    Effect.sync(() => {
      process.exitCode = 1
      console.error(error.message)
    }),
  ),
)

await Effect.runPromise(program)
