// The shared SolZero lint setup (oxlint-plugin-solzero) with Grokcast's ignores.
// `nub run lint` runs oxlint with --deny-warnings, so a rule at warn fails lint too.

import { defineConfig } from "oxlint"
import { agentToolIgnorePatterns, effectRules, recommended } from "oxlint-plugin-solzero/config"

export default defineConfig({
  extends: [recommended],
  plugins: ["unicorn", "typescript", "oxc", "react"],
  categories: { correctness: "error" },
  // Oxlint does not inherit ignorePatterns through extends, so spread the shared list.
  ignorePatterns: [...agentToolIgnorePatterns, "**/dist/**", "**/node_modules/**", "raycast-env.d.ts"],
  overrides: [
    // Effect services. The views in src/*.tsx bridge Effect to React, and tests drive
    // services from outside, so the composition rules check only src/lib.
    { files: ["src/lib/**"], rules: effectRules("error") },
  ],
})
