# peer-bridge

Let **Claude Code** (the Code tab of Claude Desktop) and **ChatGPT Desktop** check each other's work from their own desktop apps. Both sides are ordinary chats in the official apps; no model APIs are used. Either app can take either role.

- **Advisor:** a chat in one app reviews every turn of a primary chat in the other.
- **One-off review:** ask a chat in the other app once, optionally in a brand-new ChatGPT thread with a model you pick.
- **Plan review:** a one-off review of a plan before it is built (`kind="plan"`). Afterwards the primary shows you the plan and the verdict and waits for your approval.

> **Status: alpha.** It works end to end on Windows, in both directions, in the author's setup. On macOS, Claude Code reviewed by ChatGPT (advisor links and one-off reviews) works; the other direction hasn't been tried on a Mac yet.
>
> The ChatGPT side relies on undocumented parts of the app: its bundled `codex app-server` experimental API and the `codex://threads/wake` deep link. Any app update can break these.
>
> Code you work on is sent to the other vendor's chat.

## How it works

```
primary chat ──Stop hook──▶ outbox ──▶ broker ──▶ advisor chat
     ▲          (question, answer, diff)              │
     └─ [CHANGES REQUESTED]: wakes the primary ◀─────┘ bridge_advise
           [APPROVED] + nits: added to the user's next prompt
```

**Trigger.** A non-blocking `Stop` hook in both apps queues each finished turn of a linked primary for review. It never holds the turn open and never waits. The review request contains:

- the user's message for that turn,
- the primary's final answer,
- the git diff of what changed in the working tree during the turn.

**Diff baseline.** The `UserPromptSubmit` hook takes a snapshot when the turn starts, using `git stash create`, which doesn't touch any files or refs.

- Edits to files that were already untracked when the turn started are listed by name.
- Repos without commits work.
- The whole diff, including the summary, is capped.

**Secrets.** Paths that tend to hold secrets are never included, neither their content nor their names:

- files: `.env*`, keys and certificates, `*secret*`, `*credential*`, `.netrc`, `.npmrc`;
- whole directories: `secrets/`, `.ssh/`, `.aws/`, and any directory named like `*secret*` or `*credential*`.

**Waking the other chat:**

- **ChatGPT:** the whole message goes into the thread's own queue, through the app's bundled `codex app-server`. `codex://threads/wake/<id>` then makes the desktop app run it. The user reads both sides in that chat:
  - each incoming message starts with its sender (`CLAUDE:`) and ends with a fixed line saying it is an agent message, not a user instruction;
  - after `bridge_advise` or `bridge_send`, the chat is told to write what it sent as its reply.
- **Claude Code:** a short notice wakes the session, which reads the message with `bridge_receive`. A background hook with `asyncRewake` exits 2 when something arrives for that session. It is re-armed on every `Stop` and `SessionStart`, so it survives restarts without the model doing anything.

**Identity.** The bridge learns which chat is calling from the host itself: `CLAUDE_CODE_SESSION_ID` on the Claude side and `_meta.threadId` on the ChatGPT side. It never relies on the model remembering, so context compaction can't break a link.

**Answers.** Advisors and reviewers answer with `bridge_advise(request_id, decision, note, blocking, nits)`. Every answer reads the same in both chats: `[APPROVED]` or `[CHANGES REQUESTED]` first, then the note, the must-fix items, and the nits, which never block approval. An approval with must-fix items, or a rejection without any, is refused.

**Fix loop.** After `[CHANGES REQUESTED]` the primary fixes what holds up, says why when it thinks a finding is wrong, and asks again; the reviewer answers each objection. The primary itself stops and asks the user when it's going in circles. The bridge adds its own fixed instructions to each answer, never the reviewer's words.

| Mode | `[CHANGES REQUESTED]` | `[APPROVED]` |
|---|---|---|
| Advisor | The primary is woken, and its next turn is reviewed again. | Nits wait for the user's next prompt; without nits nothing is sent. |
| One-off review | The answer goes back; the primary asks for the next round with `bridge_review(round_of=…)`: same reviewer, same kind, "Round N" in the request. | The answer goes back; the review is done. |

An emergency cap stops two agents looping: after 20 rounds in a row without approval (`PEER_BRIDGE_MAX_ROUNDS`), a review can't be continued, and an advisor's primary is told once to stop and ask the user and isn't reviewed again until the user writes. In advisor mode a new user prompt starts the count over; answers to turns from before it no longer steer. Repeated nits are dropped.

**Problems are visible.** These problems show up in the affected chat's next prompt, and in `bridge_status`:

- a ChatGPT delivery fails (for example, the app isn't available),
- a Claude advisor session isn't open and listening.

**Broker.** A small local store shared by both apps' MCP servers: localhost HTTP plus a state file. Hooks never use the network; they read the state file and drop requests into an outbox folder. If the owning process dies, another server takes over within about 2 s. Old messages are pruned: read ones after a day, everything after a week. Unread messages are never dropped by count.

## Tools

| Tool | Purpose |
|---|---|
| `bridge_link` | Make this chat a primary whose every turn is reviewed. From Claude, `advisor="openai"` creates a new ChatGPT advisor thread, running read-only, where you can pick the `model` and reasoning `effort`. `advisor="join"` returns a code that any existing chat can use. |
| `bridge_review` | Ask for a one-off review of a `request`. The chat's own uncommitted changes are attached; on the ChatGPT side they are attached only when the project folder is known. From Claude, `reviewer="openai"` opens a new ChatGPT thread (for example `model="gpt-6-luna"`, `effort="high"`), or continues in an earlier reviewer's thread with `thread_id`, keeping that chat's context. `reviewer="join"` returns a code. `kind="plan"` reviews a plan instead: no changes attached by default, and the requester waits for the user's approval before building it. `round_of` asks the same reviewer for the next round after `[CHANGES REQUESTED]`. The answer arrives as a new turn. |
| `bridge_link_join` | Become the advisor or reviewer of a link, using its code. |
| `bridge_advise` | The advisor's or reviewer's answer: `approved` or `changes_requested`, with must-fix items and nits apart. It names the request it answers (`request_id`, required), so a chat serving several links can't mix them up. A plain message isn't a review request: it is answered with `bridge_send`. |
| `bridge_unlink` | Close this chat's links. |
| `bridge_status` | Show this chat's links, their health, whether Claude sides are listening, and pending notes. |
| `bridge_receive` / `bridge_send` | Read incoming messages. `bridge_send` sends a free-form message to the chat on the other end of this chat's latest link, which is woken to read it. |

## Install

Requires Node.js 22+, git, and both desktop apps.

```bash
npm install
node scripts/install.mjs            # node scripts/install.mjs --uninstall to remove
```

The installer:

- registers the MCP server in Claude Code (user scope) and in ChatGPT Desktop (`~/.codex/config.toml`);
- adds the hooks to `~/.claude/settings.json` and `~/.codex/hooks.json`;
- allows the bridge's own tools without approval prompts on both sides, because a woken chat can't wait for a click;
- backs up every file it changes and leaves other settings and hooks alone.

On Windows, Codex hooks get a PowerShell-safe command.

Restart both apps afterwards. Hooks point at this checkout, so re-run the installer if you move it.

ChatGPT Desktop reads hooks only when it starts. It also skips a new or changed hook until that hook is trusted, and it does this without any warning. After installing or updating, restart ChatGPT normally, with its window open. Then check:

```bash
npm run doctor
```

`doctor` reads everything and changes nothing. It checks:

- Node and git;
- the broker, and requests from hooks that are waiting;
- the MCP registration, tool permissions and every hook on both sides, including Codex's own view of whether each hook is trusted, and whether the hook commands actually run;
- the queue API in the installed ChatGPT version;
- active links: failed deliveries, and Claude sessions that aren't listening.

Each problem comes with the fix.

## Your rules

Standing instructions for every agent working through the bridge, in either app, go in one optional markdown file:

- macOS and Linux: `~/.config/peer-bridge/rules.md` (or `$XDG_CONFIG_HOME/peer-bridge/rules.md`)
- Windows: `%APPDATA%\peer-bridge\rules.md`
- anywhere else: set `PEER_BRIDGE_CONFIG_DIR`

Write plain sentences, for example:

```markdown
Always answer in Turkish.
Never commit without my approval; staging is fine.
When you review, don't run the tests.
```

The whole file (up to 8,000 characters) reaches every chat that is linked or has just had a bridge message: with each prompt, and with the bridge's tool results. It never travels inside a message from the other agent, so that agent can't forge it. Your direct instructions in a chat come first. These are instructions, not enforcement: the bridge can't stop an agent from ignoring them. `npm run doctor` shows whether the file is found.

## When the other side is closed

When an agent starts something with the other side (`bridge_review`, `bridge_link` to ChatGPT, `bridge_send`) and that side is closed, nothing is sent. The agent is told to ask you, and if you agree it calls again with `open=true`: the bridge opens ChatGPT Desktop, or the exact Claude Code session in Claude Desktop (`claude://code/continue`), and then sends. Say "always" and it passes `remember=true`, which sets `"openClosedApps": "always"` in `config.json` next to `rules.md`; from then on closed apps are opened without asking.

- "Closed" means ChatGPT Desktop isn't running, or the Claude session isn't listening.
- A Claude session can only be opened if its own bridge server has reported Claude Desktop's id for it; otherwise you're asked to open it by hand.
- Messages the bridge sends on its own (an advisor's review of each turn, an answer coming back) don't ask: a closed Claude session's message waits for it as before, and ChatGPT is still started by its wake link.

## Known limits

- A ChatGPT thread runs the bridge's messages as prompts. The bridge recognises its own by their exact text, once each. If you paste one of them verbatim before the bridge's own turn for it runs, your paste counts as the bridge's and the real delivery as yours, which only restarts the fix-loop count.
- A Claude Code session can only be woken while it is open in Claude Desktop. Reviews for a closed advisor session wait until it opens, and the primary is told.
- The Claude listener stops after 12 hours without activity. It re-arms with the next turn of that session.
- Advisor and reviewer threads that the bridge creates in ChatGPT run read-only. A chat that joins with a code keeps its own permissions; it is only told not to act on the project.
- On macOS, ChatGPT as the primary with a Claude advisor hasn't been verified yet.

## Tests

```bash
npm test
```

- `scripts/test-git.mjs`: turn diffs (secret exclusion, repos without commits, untracked edits, size cap).
- `scripts/smoke.mjs`: end to end over MCP with two real server processes, the hooks, and a throwaway git repo.
- `scripts/test-link.mjs`: links, reviews, hooks, error notes, pruning and broker ownership handover.
- `scripts/test-install.mjs`: install, reinstall and uninstall against throwaway config directories.
- `scripts/test-doctor.mjs`: doctor reports a missing install, and catches Codex hooks that are installed but not trusted.

## Repository layout

- `src/`
  - `server.mjs`: MCP server.
  - `broker.mjs`: shared state.
  - `hook.mjs`: hooks for both apps.
  - `git.mjs`: turn diffs.
  - `codex.mjs`: ChatGPT thread driver.
  - `caller.mjs`: caller identity.
  - `platform.mjs`: OS paths.
- `scripts/`
  - `install.mjs`, `doctor.mjs`
  - the tests
  - `send.mjs`, `codex-thread.mjs`: debugging helpers.
- `docs/notes/`: working notes (in Turkish) with the experiments and measurements behind this design.

## License

[MIT](LICENSE)
