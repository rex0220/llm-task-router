# llm-task-router

*[日本語版 README](README.ja.md)*

TypeScript CLI for a thin ModelRouter that drives a multi-step article workflow (Qiita, Zenn, blog, …).

## Requirements

- **Node.js >= 20** (the CLI and its dependencies use the `node:` import scheme and modern APIs; older Node such as 14/16 will fail to load).

## Install

Global install builds a single bundled CLI (`dist/llm-task-router.js`) exposed as the `llm-task-router` command:

```bash
# from npm (the package is scoped; the installed command is still `llm-task-router`)
npm install -g @rex0220/llm-task-router

# or from a packed tarball
npm run build && npm pack
npm install -g ./rex0220-llm-task-router-<version>.tgz
```

The CLI reads `config/models.yaml`, `config/profiles/`, `config/criteria/`, and `.env`, and writes `runs/`, all **relative to your current directory**. Scaffold the config templates into your working directory with `init`:

```bash
cd my-articles
llm-task-router init          # copies config/, .env.example, and the editor-in-chief set (.claude/, CLAUDE.md) here (won't overwrite; use --force)
cp .env.example .env          # then set your API keys
# edit config/models.yaml to set real model IDs
```

Then run it anywhere under that directory:

```bash
llm-task-router --help
llm-task-router -v
llm-task-router article:create --topic "..."
```

API keys go in a `.env` in your working directory. `config/models.yaml` can refer to separated key names with `providers.*.api_key_env`; if omitted, providers fall back to standard names such as `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`.

## Using Claude Code as the editor-in-chief

`llm-task-router` is the thin execution layer; the editorial judgment can be driven by **Claude Code acting as the editor-in-chief**. `llm-task-router init` distributes not just `config/` but the editor-in-chief set — `.claude/` (sub-agents, slash commands, and a pipeline allowlist) and `CLAUDE.md`. That set is a primary feature, not an add-on.

Each stage maps a Claude Code operation to the CLI command it drives:

| Stage | Claude Code (slash command / sub-agent) | CLI it drives |
| --- | --- | --- |
| Draft the topic file | `/draft-topic` | writes `topics/<slug>.txt` (no body yet) |
| Create → refine → gate | `/write-article` → `article-editor-in-chief` | `article:create` → `article:refine` |
| Fact-check (Web) | `article-factchecker` (separate external check) | findings → `article:revise --instruction-file` |
| Type/syntax-check code (**off by default**; only with `article:create --code-check`) | `article-build-verifier` (`tsc --noEmit` static check; **does not run the code**) | findings → `article:revise --instruction-file` |
| Editorial review | `/review-editorial` | `article:review-editorial` → `article:revise` |
| Publication decision | editor-in-chief writes `runs/<id>/publication-check.md` and recommends GO/NO-GO | **user approves**, then `article:export` |
| Update a published article | `/update-article` | `article:import` → `article:update-diff` → `article:export` + `article:record-publication` |

Operating rules the editor-in-chief follows:

- **Never edit `final.md` by hand.** Every fix goes back through `article:revise --instruction-file`, so artifacts stay under `runs/` and the previous version is kept as `final.bak.md`.
- The outside AI is an **operator**: it runs the CLI and reads `final-review.md` / the reports to judge — the body itself is written by the internal models in `config/models.yaml`.
- **`article:export` runs only after user approval.** Publication-equivalent steps are never auto-run.

## Commands

Run with no arguments (or `--help`) to list commands; `-v` / `--version` prints the version. Each command supports `--help` (e.g. `llm-task-router article:export --help`).

```bash
# Inline topic
llm-task-router article:create --topic "AIが解釈しやすい中間言語を設計する"

# Long instructions from a text file (--topic / --topic-file: provide exactly one; both is an error)
llm-task-router article:create --topic-file topics/ai-ir.txt

# Target a different platform via a profile (default: qiita). Profiles live in config/profiles/.
llm-task-router article:create --topic-file topics/ai-ir.txt --profile zenn

llm-task-router article:resume --run 2026-06-16-example
llm-task-router article:review --run 2026-06-16-example

# Apply a free-form revision instruction to final.md (--instruction / --instruction-file: pick one)
llm-task-router article:revise --run 2026-06-16-example --instruction "Make the intro shorter; add one analogy"

# Evaluate final.md with a separate judge model and generate a revision-instruction draft
llm-task-router article:evaluate --run 2026-06-16-example --min-severity major --criteria "Focus on accuracy and working code examples"

# Auto-loop evaluate→revise until the article passes (or max-rounds). The automated version of evaluate+revise.
llm-task-router article:refine --run 2026-06-16-example --max-rounds 3 --min-severity major --until clean

# Export the final article to a chosen path (e.g. a Zenn repo). --force to overwrite.
llm-task-router article:export --run 2026-06-16-example --out ../zenn-content/articles/my-article.md

# --- Importing / updating an already-written or published article (separate from create) ---
# Import an existing Markdown article into a run so evaluate/refine/revise can brush it up
llm-task-router article:import --from ../old/my-article.md --profile qiita

# Generate the update diff (update-base.md → final.md) for focused fact/build re-checking
llm-task-router article:update-diff --run 2026-06-16-my-article

# Record a publication: update meta.published and export/index.json (a separate step from export)
llm-task-router article:record-publication --run 2026-06-16-my-article \
  --slug my-article --url https://qiita.com/.../items/xxxx --article-id xxxx --article-version 2

# Editorial review (reader/editor critique) by a model different from the body writer
llm-task-router article:review-editorial --run 2026-06-16-example
# Re-review after a revision, tracking which weaknesses are resolved
llm-task-router article:review-editorial --run 2026-06-16-example --mode continuation
```

With `--topic-file`, the `runId` is derived from the file name (e.g. `ai-ir.txt` → `2026-06-16-ai-ir`). Use `--run <runId>` to set it explicitly. Outputs are saved under `runs/<runId>/`.

## Development

```bash
npm install
cp .env.example .env
npm run build    # type-check + bundle the CLI to dist/
npm test
```

During development you can run the CLI without building via the `npm run article:*` scripts (note the `--` separator forwards flags) or `npx tsx`:

```bash
npm run article:create -- --topic-file topics/ai-ir.txt --profile zenn
npx tsx src/index.ts article:create --help
```

To use the global `llm-task-router` command against your working copy, link it:

```bash
npm run build
npm link            # makes `llm-task-router` resolve to this repo
# ...
npm rm -g llm-task-router   # unlink when done
```

### Article profiles

`--profile <name>` (default `qiita`) selects a profile from `config/profiles/<name>.yaml`. A profile defines:

- `platform` — the label woven into every step prompt (`<platform>記事` / `<platform>向けMarkdown`)
- `style` — platform conventions (admonition syntax, front-matter rules, etc.) injected into the body-producing prompts (draft / final / revise)
- `language` — informational

Bundled profiles: `qiita`, `zenn`, `blog`, `note`. Copy one to add your own (e.g. `config/profiles/devto.yaml`). `--platform <name>` overrides just the label from the profile. The resolved `platform` and `style` are stored in `meta.json`, so `resume` / `review` / `revise` / `evaluate` reuse them automatically. Pair a profile with a matching `--criteria-file` for platform-specific evaluation.

`article:revise` rewrites `final.md` from your instruction and the current `final.md`, backing up the previous version to `final.bak.md`. (`article:review` instead re-runs the automatic review→rewrite from `draft.md` and ignores custom instructions.)

`article:export --run <runId> --out <path>` copies the run's `final.md` to a destination of your choice (only `final.md` is exported). It refuses secret filenames (`.env*`), warns when writing outside the workspace, and will not overwrite an existing file unless `--force` is given. This is the explicit, guarded exception to the "no arbitrary write destinations" rule — internal artifacts stay confined to `runs/<runId>/`.

`article:evaluate` reviews the current `final.md` with a separate judge model (the `final_review` task in `models.yaml`, defaulting to a different provider than the body writer) and writes three files to `runs/<runId>/`: `final-review.json` (raw scorecard), `final-review.md` (human-readable summary — verdict, per-severity counts, and all issues), and `revise-instruction.md` (actionable instructions filtered by `--min-severity`, `critical|major|minor|suggestion`, default `suggestion`). The instruction file is built locally (no extra API call) — review/edit it, then feed it to `article:revise --instruction-file`. It does not auto-rewrite. `--criteria` / `--criteria-file` focuses the evaluation on specific points.

Evaluation criteria live in `config/criteria/` and are associated with each profile via the profile's `criteria_file`. `article:evaluate` resolves the criteria automatically from the run's profile (stored in `meta.json`), so the usual command needs no `--criteria-file`:

```bash
llm-task-router article:evaluate --run <runId> --min-severity minor
```

Resolution order: `--criteria` (inline) > `--criteria-file` (explicit override) > the run profile's `criteria_file` > none. Bundled: `config/criteria/default.md` (general technical rubric, used by `qiita`/`zenn`/`blog`) and `config/criteria/note.md` (readability-focused, used by `note`). To use a different rubric for one run, pass `--criteria-file <path>`. Because LLM-as-judge results vary run to run, a fixed per-profile criteria file makes evaluations consistent and comparable.

`article:refine` is the **automated** evaluate→revise loop (`article:evaluate` + `article:revise` run repeatedly for you). Each round it judges `final.md` with the `final_review` model and, if the stop condition is not met, applies the generated instruction with the `rewrite` model. It uses the same criteria resolution as `article:evaluate`.

- `--max-rounds <n>` (default `3`): the maximum number of evaluate passes. `revise` runs at most `n-1` times, so a run costs at most `2n-1` model calls. This is the required safety valve.
- `--min-severity <level>` (default `major`): in `--until clean` mode the loop continues while issues at or above this severity remain.
- `--until <clean|approved>` (default `clean`): stop when no `min-severity` issues remain (`clean`), or when the judge marks the article `approved` (`approved`).

It stops with one of: `clean`, `approved`, `max-rounds`, `stalled` (quality score stopped improving), `regressed` (score got significantly worse — damage control to avoid spiraling), or `no-instruction` (the judge withholds approval but lists nothing actionable). Success conditions (`clean`/`approved`) take priority over `stalled`/`regressed`. Every round's evaluation, applied instruction, and pre-revise snapshot are kept as flat artifacts in `runs/<runId>/`: `refine-r<N>-review.json` / `refine-r<N>-review.md` / `refine-r<N>-instruction.md` / `refine-r<N>-before.md`, plus a `refine-summary.md` overview, and the final round is also copied to `final-review.{json,md}`. The loop never rolls back (`final.md` is always the latest applied version); on `regressed` it stops and points you to the specific pre-revise snapshot from the round before the regression (`refine-r<N>-before.md`, where `<N>` is one less than the round that detected it) so you can pick a better version by hand. Progress and the full round history are recorded under `meta.json`'s `refine` field.

### Importing and updating existing articles

`article:import --from <path>` is the opposite entry point to `export` (outside → run): it loads an existing/published Markdown file as `final.md` of a fresh run so `evaluate` / `refine` / `revise` can brush it up. The run is flagged `imported: true` in `meta.json`; because import runs have no generation-stage artifacts, `resume` / `review` are rejected (use `evaluate` / `refine` / `revise`). Pair it with `--criteria-file` to set the brush-up rubric. See [docs/article-import-proposal.md](docs/article-import-proposal.md).

For **re-publishing an already-public article** (keeping the same URL and skeleton, changing only what went stale), import is also the starting point of a dedicated update flow driven by the `/update-article` skill. It pins **three sources of truth**: the version baseline (`update-base.md`, the body fixed at import time), the publication target (`meta.published`), and the run lineage (`meta.lineage`).

- `article:import --from export/<slug>.md --supersedes <prev-run> --root <root-run>` saves `update-base.md` and records `lineage` in `meta.json`.
- `article:update-diff --run <id>` diffs `update-base.md` against the current `final.md` and writes `update-diff.md` (a unified-style diff) and `changed-sections.json` (per-heading add/remove counts), so the fact-checker / code type-checker can review **only the changed sections** instead of the whole article.
- `article:record-publication --run <id> --slug <slug> --url <url> --article-id <id> --article-version <n>` updates `meta.published` and the `export/index.json` ledger (slug → latest run / URL) **together**. This is deliberately separate from `export` (which only copies `final.md`): export does a local write, `record-publication` records the publication. It guards against version regressions for the same slug (an identical re-run is a no-op; an intentional correction needs `--force`). The flag is `--article-version` (not `--version`, which is the CLI's own version flag). Like `export`, it is a publish-equivalent step; since v0.2.31 it **is** in the editor-in-chief allowlist (no command-execution prompt), but publishing still requires the editor-in-chief's GO/NO-GO and your approval — confirm the target URL before running.

### Editorial review (independent reviewer lens)

`article:review-editorial --run <id>` runs a reader/editor critique with a model **different from the body writer**. Independence is enforced at runtime: the final author's provider is excluded from the reviewer candidate set (the `editorial_review` task in `models.yaml` spans both providers so one always remains). `--allow-same-provider` allows the same provider with a different model (the exact same model is still dropped); `--allow-same-model` allows the exact same model. Imported (external/human-authored) runs are exempt. It is a third reviewing lens alongside the judge (`evaluate`/`refine`) and the external fact/build checks — **not** a correctness gate (facts still go to the fact-checker).

It writes a scorecard (`editorial-review.json` / `editorial-review.md`) and a **candidates** file (`editorial-instruction.candidates.md`) containing only `major`/`minor` weaknesses that are `open` or `partial` (`preference` and `resolved` are excluded). Candidates are not applied automatically: the editor-in-chief selects which to adopt into a confirmed `editorial-instruction.md`, then `article:revise --instruction-file` applies that file. `--mode continuation` re-reviews after a revision — it diffs the previous review's body snapshot against the current `final.md` (since-last, not cumulative), passes the prior unresolved weaknesses, and tracks which are resolved. A run-level ledger (`editorial-ledger.json`) owns the `WNNN-<hash8>` weakness ids so they stay stable across rounds; a periodic independent full read closes weaknesses it no longer reports.

## Progress Output

All commands print per-step progress to **stderr** while `runId` / `final` paths go to **stdout** (so scripts can parse stdout without mixing in progress lines).

```text
[1/5] brief (article_brief) ...
[1/5] brief - done via openai/gpt-5.4 (2310ms, ~$0.0123)
[2/5] outline (outline) ...
[2/5] outline - done via anthropic/claude-opus-4-8 (4120ms, ~$0.0456)
total: ~$0.1240 (estimate)
```

Each line shows the provider/model actually used, the elapsed time, and an estimated cost; a run total is printed at the end. A provider different from the configured primary indicates a fallback. `article:resume` / `article:review` show already-completed steps as `skip (done)`.

Cost is a **local estimate** from the response's `usage` token counts and the `prices` in `config/models.yaml` (USD per 1M tokens) — no extra API call. Models without configured prices (or priced at `0`) are omitted from the cost output. Prices drift, so keep them current.

### Output Guards

For prose steps (draft / rewrite / revise), the saved Markdown gets two lightweight guards:

- **Truncation warning** — if the model output was cut off at `max_tokens` / `max_output_tokens`, the step prints a `⚠` warning so you can raise `max_tokens` and rerun.
- **Code-fence stripping** — if the model wrapped the entire document in a ``` fence, the outer fence is removed before saving. Legitimate inline/multiple code blocks are left untouched. Schema steps save validated JSON and are not affected.
- **Wrap-text detection (warn only)** — if the prose opens with a meta preamble (e.g. "以下は…改稿版です") or ends with follow-up offers (e.g. "…で出し直せます"), the step prints a `⚠` warning. Detection is phrase-based (not "must start with a heading"), so a legitimate lead paragraph before the first heading — normal for Zenn/note — does not trigger it. It does not auto-edit prose; the fix is left to you.

## Security Notes

This MVP is CLI-only. It does not expose an HTTP API, run arbitrary code, fetch arbitrary URLs, or store full prompts in logs. Error logs are normalized and should not include API keys, raw SDK responses, headers, or full input text.

## Model Notes

Some provider/model combinations do not accept generation parameters such as `temperature`. Provider implementations omit unsupported parameters where known, and model names in `config/models.yaml` should be verified against the current provider API before real use.
