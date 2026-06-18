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
