# Agent-time checks

The gate's ledger (`ledger.json`, in the report artifact of any run) maps every rule to its implementation, its tests,
its limits and its open issues. Give it to the coding agent, and the agent knows what a file must keep true before it
edits it, instead of finding out from a red pull request.

Paths below assume a checkout of this repository at `.quality-gate/tool` (`git clone --depth 1 https://github.com/Mira190/ai-quality-gate .quality-gate/tool && npm ci --prefix .quality-gate/tool`).

Get a ledger: download the artifact of the last default-branch run (`gh run download -n ai-quality-gate-<run id>`) and
put `ledger.json` at `.quality-gate/ledger.json` (add the folder to `.gitignore`), or run the report locally.

## MCP server (any MCP client)

`.mcp.json` at the repository root:

```json
{ "mcpServers": { "quality-gate": { "command": "node", "args": [".quality-gate/tool/agent/mcp-server.js", "--ledger", ".quality-gate/ledger.json"] } } }
```

Tools: `rules_for_file(path)`, `rule(id)`, `impact(files)`.

## Claude Code hook (automatic)

`.claude/settings.json`:

```json
{ "hooks": { "PostToolUse": [ { "matcher": "Edit|Write|MultiEdit", "hooks": [ { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR\"/.quality-gate/tool/agent/after-edit-hook.js", "timeout": 10 } ] } ] } }
```

After each edit the agent gets, next to the tool result: the rules the file carries, their limits, the tests that guard
them, and "NO TEST: add one that names the rule ID" where there is none. The hook never blocks an edit.
