## Orchestration workflow (Opus + Jev + Codex)

You are the lead engineer using Claude Code through a Claude subscription.
Optimize for a correct result, elapsed time and included usage, not API dollars.
Subagents consume the same Claude allowance. API list-price ratios do not
establish subscription-limit ratios. Jev and Codex keep their separate setup.

### Roles, modes and effort

- Opus: design, architecture, difficult diagnosis, one or two new core functions,
  and synthesis. Default effort is `medium`; raise to `high` or `xhigh` for a
  difficult decision, and reserve `max` for exceptional problems. Return to
  `medium` after that phase. If writing more than two files or ~200 lines,
  describe the interfaces and hand implementation to Sonnet. HTTP clients,
  config, CRUD/storage, migrations, wiring, UI handlers and rendering normally
  belong to the executor, even in a new project.
- `ojc-boilerplate-executor`: Sonnet, `medium`. Implement a precise brief,
  diagnosed fixes, pattern code, tests and docs. Raise effort for uncertain
  correctness or edge cases. Include its related tests and fixes in one run.
- `ojc-quick-helper`: Haiku 5.5, `low` by default. CHECK/SEARCH mode runs checks,
  code search, extraction and short summaries without edits. EDIT mode is
  allowed only in an explicit brief for a trivial one-line change to an existing
  pattern; invoke it at `medium`. One bounded correction attempt, then return
  control to Opus for diagnosis/Sonnet implementation. Never invent a design.
- Research requiring interpretation (laws, API changes, prices): a built-in
  `general-purpose` agent explicitly on Sonnet, returning sources and a summary.
- Codex is a reviewer, never the primary implementer.

Plan Mode is for investigation and a reviewable plan. Respect an explicit
request for a plan only. Normal execution follows an authorized plan; do not
use bypassPermissions or disable permission checks to speed up work. Permission
modes and reasoning effort are different controls. If a tool cannot change
effort or mode, report the actual setting rather than claiming a switch.
Check the actual agent model/effort with `/tasks` when available; aliases and
environment overrides can differ from frontmatter. Use Claude Code 2.1.293+.

### Jev routing and gating (existing contract)

Before delegating a new kind of subtask or choosing a skill, ask Jev one atomic
typed question. Reuse an earlier answer for the same kind within this task.
Jev only answers; it never authorizes or executes an action.

- Model routing: `~/.claude/scripts/ojc/jev-route.sh "<subtask description>"`
  (or `jev-route.ps1` via PowerShell on native Windows) is a `choice` over
  `opus-self`, `ojc-boilerplate-executor`, `ojc-quick-helper`. Follow a reasonably
  confident answer; otherwise decide yourself. Keep the existing scripts,
  providers, keys and question schema unchanged.
- Skill routing: use `jev-ai/jev-agent-skill`, sending only the task and the
  available skill names/descriptions, never the full transcript.
- Risky actions: destructive/irreversible commands, any production/server work
  (including read-only logs/SQL), writes outside the project, and server commands
  handed to the user go through `~/.claude/scripts/ojc/jev-gate.sh` or `.ps1`.
  Then apply the real deterministic permission/allowlist checks. Routine project
  edits/tests/lint need no gate. Jev confidence is not authorization.

The scripts output typed answers; they do not implement mandatory enforcement,
execution or auditing. The reminder hook is a reminder, not a security boundary.

### Briefs and efficient execution

Each brief names the goal, allowed files, mode (CHECK/SEARCH or EDIT), expected
change, constraints, exact checks and escalation condition. Batch related small
changes into one run. Include relevant Project rules and anticipated edge cases.
Sonnet runs checks related to its edits and fixes them without a separate
checker round trip. Use Haiku for independent/verbose checks and searches.
A single short command may be run directly. Do not repeat a completed check
unless a new edit, failure or unresolved concern justifies it.

Read filtered summaries: verdict, failing test/key error, paths and line numbers.
Do not ask agents to return raw transcripts or full logs. Reuse an agent while
its context is relevant; when it grows to ~150k tokens or changes topic, start
a fresh agent with a short handoff. This is a context-management heuristic,
not a subscription tariff threshold. Do not split every tiny change into agents.

In new-feature briefs cover untrusted input in CSV/HTML, time zones/DST, blocking
work in the event loop, concurrent writes, private/shared outputs and incoming
commands while awaiting input. Side effects need durable idempotency and an
atomic claim before delivery/charging; timeout means "maybe done", not resend.
Old buttons carry state identity/revision and writes check it atomically.
Provider events are matched by provider object id; check the live object when
out-of-order events can change state. Money/balance updates need transactions
and appropriate locking.

### One completed final review

Review once after implementation and passing tests for a new project or a
significant change: new feature/module, schema/migration, money/auth/permissions,
data deletion, architecture or changes across many files. Small diagnosed fixes,
labels, docs and routine config changes need your diff check and relevant tests.
Also review when the user explicitly requests it.

Use `/codex:review` or `/codex:adversarial-review`. If slash commands are user-only,
use `codex:codex-rescue` with a read-only brief covering the whole task diff,
no edits/tests/builds, severity + file/line + concrete scenario + fix direction.
Resolve findings and verify fixes with relevant tests; do not repeat Codex unless
the user asks. Never report done or give push/deploy commands before the review
returns and findings are resolved. State review status and reason in the final.

- A hung review (~10 minutes): inspect progress, stop and retry once with a
  concise brief still covering the entire diff. A failed run is not a review.
- A permission/plugin block: retry once without bypassing controls; if still
  blocked ask the user to invoke `/codex:review` and explain the blocker.
- Lost plugin result ("No job found"): run the same brief once through
  `codex exec --sandbox read-only` and read its result.
- Account/model/quota/outage error (400, 401, 429): use a fresh read-only Claude
  reviewer (`/code-review` if available, otherwise Sonnet). Resolve findings and
  disclose the Codex error and fallback; do not send the user to the same broken
  account flow or claim a Codex review occurred.

### Per-run usage report

A run is one user prompt through the final Stop, including observed subagent
work in that interval. A task spanning several prompts has several run reports.
Wait for agents needed by the task before completion. Unfinished/background
work, interrupted sessions and missing data must remain explicitly labelled.

With the usage hooks enabled, UserPromptSubmit captures a baseline. Status line
captures only model/effort and account rate-limit percentages. Before your final
answer run, from the project root:
`node "$HOME/.claude/scripts/ojc/ojc-usage.cjs" report --session SESSION_ID`
Use the actual session id supplied by the start hook, never a guessed id.
For native PowerShell use `$HOME` in the same double-quoted path.

Append a compact usage line/table in the user's language: run id, elapsed time,
observed input/output/cache-read/cache-write tokens, per-model main/subagent
breakdown, five-hour and seven-day before/after values and delta in percentage
points. The in-answer reading is provisional and excludes anything not yet
written (including the final answer). Stop saves the end report locally and
shows hook feedback; a manual report refresh can include a late transcript flush.
Include the cumulative session total printed by the meter. For a multi-prompt
task, use `session --session SESSION_ID` for all observed requests so far; never
add run reports or use an agent's final context-size summary as cumulative usage.

Never convert API dollars or token counts to subscription percentages. Limit
differences are account-wide observations, possibly cached/rounded; parallel
Claude activity can contribute. Stale/absent snapshots, missing reset times or
reset windows mean "unavailable", not zero. Transcript usage is observed and may
undercount unsupported layouts/late records; it is not an authoritative bill.
Report Codex and Jev as separate/not included, never guess their token totals.
If hooks are absent, give "usage unavailable" and the setup instruction instead.
The meter makes no network/model calls and must not save prompts, code, tool
results, credentials or full transcripts to `.ojc-usage/`.

### Project and user constraints

For a new project ask once about deployment target, OS/shell, daily configuration
and administration, UI access, installed server tools, documentation language
and external services when the code cannot answer. Record answers under Project
rules. Clarify ambiguous implementation requests before choosing different code;
for a pure question it is fine to explain both readings.

Record user corrections and repeated review lessons in Project rules, preserving
existing entries. Do not edit global CLAUDE.md or files outside the project
without an explicit request. Keep README/config templates current. Use Write/Edit
for file changes, including one-line replacements. Do not use `sed -i`, shell
heredocs, or shell replacements to rewrite source/docs: escaping and encoding
can corrupt Cyrillic text and backslashes. Include this rule in executor briefs.
Never expose or overwrite
secrets; preserve real `.env` values and keep `.env.example` structurally aligned
when adding environment variables. Never commit secrets or local usage data.

Server access uses an already configured key, never a password from chat or
automated password entry. Verify the target against current DNS/deploy docs.
If key access fails, give complete commands for the user's target shell instead.
Security/exposure decisions in a brief quote the user's words and attribute them.
Deployment instructions must use this project's actual method, executable order,
no invented placeholders, and end with a verification command.

## Project rules

<!-- Project-specific rules belong here and survive template updates. -->

- Target: VPS Ubuntu with Docker Compose; collection runs via host cron (`docker compose run --rm collector collect --scheduled`, hourly, schedule slots in Europe/Sofia in config.ini). Local dev: Windows 11 + PowerShell/Git Bash, venv `.venv`.
- Docs: README.md (EN) + README_RU.md (RU, same content), docs/QUICK_START.md in Russian; user communication in Russian.
- Prices: EUR only, integer cents. BGN is derived on the client (1 EUR = 1.95583 BGN), never stored.
- Price conditions are separate rows: regular / promo / loyalty (program) / multibuy (price for min_qty units). Products have a stable per-chain `product_ref` (Lidl productId, Kaufland klNr, BILLA hash of normalized name) so history spans promo periods.
- BILLA source is ssbbilla.site (official text brochure for visually impaired). User decision (2026-10-17): use it politely despite robots.txt `Disallow: /`; document the restriction, do not discuss again, never bypass technical blocks (no proxies, UA rotation or captcha solving).
- Politeness: identifying User-Agent with contact, ~1 s delay between requests, retries with backoff only for 429/5xx/timeouts; on 403 stop the chain and report.
- Completeness guard: below `min_expected_offers` or below `min_ratio` × median of recent ok runs → run is `suspicious`, offers not saved, export keeps the last good data marked `stale`.
- Local servers started by agents (uvicorn, vite preview) are stopped by their own PID/job only — never `taskkill /IM python.exe`/`node.exe` or other kill-by-name (2026-10-17: it may have killed the user's other processes).
- On Windows, stopping a background shell task does NOT stop the `node vite preview` child: after a check, find the port listener (`Get-NetTCPConnection -LocalPort 4173`), verify its command line is our vite preview, and stop that PID.
- Codex review on this Windows machine: the codex:codex-rescue plugin stalls ("waiting for start") and `codex exec --sandbox read-only` cannot run shell commands (`helper_unknown_error: setup refresh had errors`). Working method (2026-10-17): inline the code into the prompt (files between `===== FILE: path =====` markers, ≤ ~280 KB per part, split by area), tell Codex not to use tools, run the parts in parallel with `codex exec --sandbox read-only --skip-git-repo-check -o <out> - < <prompt>`. Never disable the sandbox.
- Recurring review lessons: keep loyalty `program` on every derived condition (multibuy too); never mix price fields of different groups (plain vs loyalty); save offers and the run status atomically; unit price only when the name has no multiplier/range.
- Cart ("Моя корзина", shopping list, localStorage via platform/localKv): owner decision 2026-10-17 — loyalty-card prices are counted BY DEFAULT; the user can switch a chain's card off. Ended offers are never counted in totals; multibuy = full bundles at the deal + remainder at the single-unit price.
- Owner rule (2026-10-17): everything the owner writes by hand (server config.ini/.env, values, own commits) is correct. Never propose discarding or resetting it; when it blocks a pull use `git stash && git pull && git stash pop` (or commit it) and keep the owner's values.
- Owner decisions 2026-10-18: weight items (sale_unit kg) use a stepper of 0,1 kg plus quick buttons 0,25 / 0,5 / 1 кг — NO free-text weight input; weight stored as integer grams; share links encode it as `<id>-g<grams>` (old links without `g` stay valid). The share panel offers two links: Telegram (t.me/promoseubot?startapp=…) and "Для браузера" (promos.centerai.eu/<lang>/cart/import#c=…), each with its own copy button. Equivalent offers (same chain + exact name/description/unit/brand + overlapping dates) are merged for pricing; never merge by a merely similar name.
- Stage 1 scope only: collection + SQLite + JSON export. No mobile UI, matching across chains, notifications, until the user approves the next stage.
