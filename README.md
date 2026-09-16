# sn-mcp-example — ServiceNow MCP Server on Cloudflare Workers

A deploy-in-minutes **Model Context Protocol (MCP) server** for ServiceNow, running on
**Cloudflare Workers**. Give any MCP-capable AI agent (Claude Code, Claude Desktop,
Cursor, …) safe read/write access to your instance through the **Table API** — no
agents installed on the instance, no MID server, no plugin.

Part of the *"AI Engineer 3 Ways"* talk — this repo is **The MCP Way**:

| Way | What the AI gets | Repo |
|-----|------------------|------|
| **The MCP Way** | Curated, typed, documented tools | _this repo_ |
| **The Table API Way** | Raw REST + a great `AGENTS.md` | _(separate repo)_ |
| **The CLI Way** | A lifecycle-driven CLI (`sn`) | [sndev.io](https://sndev.io) |

## Quick start (local)

```bash
bun install        # or npm install
cp .dev.vars.example .dev.vars   # fill in your instance + credentials
bun run dev        # http://localhost:8787
```

Test it with the [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector):

```bash
npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP  →  URL: http://localhost:8787/mcp
```

### Gotcha: quoting basic-auth values in `.dev.vars`

`wrangler dev` parses `.dev.vars` dotenv-style, and **unquoted values are
silently truncated at the first `#`** (`$` also gets variable-expanded).
Generated ServiceNow passwords usually contain `#`, `$`, `=` — so an
unquoted password arrives mangled and every call fails with
`401 User is not authenticated`. Always single-quote the values (single
quotes are taken literally):

```
SN_INSTANCE='https://dev000000.service-now.com'
SN_USERNAME='mcp_service_user'
SN_PASSWORD='p@ss w1th #$pecial chars'
```

If your `.dev.vars` credentials are correct but you still get 401s, this is
the first thing to check.

## Hook it into Claude Code

```bash
claude mcp add --transport http servicenow-dev http://localhost:8787/mcp
```

Or add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "servicenow-dev": {
      "type": "http",
      "url": "http://localhost:8787/mcp"
    }
  }
}
```

## Deploy to Cloudflare

```bash
bunx wrangler login
bun run deploy
```

Then set your secrets (they become live immediately, no redeploy needed):

```bash
bunx wrangler secret put SN_INSTANCE   # https://dev000000.service-now.com
bunx wrangler secret put SN_USERNAME   # a service account, NOT your admin user
bunx wrangler secret put SN_PASSWORD
```

`wrangler deploy` prints your worker URL; your MCP endpoint is `<url>/mcp`.

> **CI/CD:** the included GitHub Actions workflow (`.github/workflows/deploy.yml`)
> deploys on every push to `main` — add `CLOUDFLARE_API_TOKEN` and
> `CLOUDFLARE_ACCOUNT_ID` as repo secrets and it just works.

## Security notes (please read)

- **Create a dedicated ServiceNow user** for the MCP server. For development, 
  you probably want admin. If you wanted to be granular, you could do specific 
  "admin-like" roles - but that is out of scope of this.
- Credentials live in Workers secrets / `.dev.vars` — never in git, never sent
  to the AI. The agent talks to *this server*; only this server talks to
  ServiceNow.
- `sn_run_script` is powerful by design — it executes server-side JS. Keep the
  credential least-privileged, and remove `tools-script.ts`/
  `tools-cicd.ts` registrations in `src/tools.ts` if you want a read-only or
  table-API-only server.
- If you expose this publicly, put **your own auth** in front of `/mcp` (the
  MCP spec's HTTP authorization flow, a Cloudflare Access policy in front of
  the worker, or a simple shared-token check) — an open MCP endpoint is an
  open door to your instance.

## Tools

| Tool | What it does |
|------|--------------|
| `sn_get_table_schema` | Live schema of any table (fields, types, mandatory, references) via `sys_dictionary` |
| `sn_query_records` | Encoded-query search over any table |
| `sn_get_record` | Fetch one record by `sys_id` |
| `sn_create_record` | Insert a record |
| `sn_update_record` | Patch a record by `sys_id` |
| `sn_run_script` | Run server-side JavaScript (GlideRecord) via a one-shot `sys_trigger` — no Scripted REST endpoint needed |
| `sn_get_current_update_set` | Show the update set the credential is currently capturing into |
| `sn_switch_update_set` | Point the credential at a named update set (GlideRecord script) so agent work is captured and reviewable |
| `sn_run_atf_suite` | Trigger an ATF test suite through `/api/sn_cicd/testsuite/run`, poll to completion, return pass/fail rollups |
| `sn_run_instance_scan` | Scan update sets with an Instance Scan suite through `/api/sn_cicd/instance_scan/suite_scan`, return violations + findings |

The bundled `memo://about` resource explains the recommended agent flow
(**discover schema → query → act**) to any client that reads resources.

## Context efficiency by design

Modern models tool-call well, MCP is stateless, and clients can defer tools.
So the anti-bloat job for this server is narrow: keep the tool surface small,
make every tool do more per call, and stay compatible with client-side
deferral. ([Anthropic's advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use),
[MCP client best practices](https://modelcontextprotocol.io/docs/2026-07-28/develop/clients/client-best-practices).)

- **Few tools, rich params.** Ten tools, each composable at call time —
  `sn_query_records` takes an encoded `query`, `fields`, `limit`, `offset`,
  and `displayValue`, so the model filters server-side in one call instead of
  paginating raw tables through its context. A param is cheaper than a tool.
- **Stateless sessionless transport.** Every `POST /mcp` is independent — no
  Durable Objects, no session state, `GET` answers 405. Nothing to keep warm,
  nothing to evict.
- **One call, one result.** The CI/CD tools trigger and poll `/api/sn_cicd`
  inside the server; the agent never sees the ~20 progress round-trips.
  `sn_get_table_schema` folds two Table API reads into one compact schema.
- **`sn_run_script` is the escape hatch.** For work no param can express, the
  agent sends one GlideRecord script; intermediates stay on the instance and
  only `setScriptOutput` returns (hard-capped at 4 KB with a truncation
  hint).
- **Compact responses.** Record summaries strip the Table API's
  `{value, display_value, link}` envelope; limits cap row counts.
- **Annotations on every tool** (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`) so hosts can reason about parallelism,
  retry safety, and confirmation policies without guessing.
- **Free discovery, cheap listing.** Unconfigured servers list zero tools;
  configured servers list deterministic definitions with 2026-07-28
  `ttlMs`/`cacheScope` cache hints so host prompt-caching holds.

Deferral and progressive discovery are client features — nothing to
implement server-side. Descriptive `sn_*` names and keyword-rich
descriptions are what Tool Search matches against; keep that discipline
when adding tools.

### If this server grows toward 100 tools

In order of leverage — take each step only when the previous one stops
being enough:

1. **Param before tool.** Before registering a new tool, try adding a
   parameter to an existing one (a `kind`, `mode`, or `query` value). Ten
   composable tools beat thirty overlapping ones — in context cost *and* in
   tool-selection accuracy.
2. **Split by audience into separate workers.** Reads vs writes vs CI/CD,
   each with its own credential scope. Hosts keep the read server always-on
   and connect the write server only for tasks that need it — server-level
   deferral beats tool-level deferral.
3. **Add the three-layer discovery pair** — `sn_search_tools` (name +
   one-line description) and `sn_get_tool_details` (one full schema) — once
   definitions genuinely cost context. Thresholds from the guidance:
   Anthropic flags >10K tokens of definitions or selection-accuracy
   problems; the MCP guidance says switch when definitions cross 1-5% of
   the window. In practice: dozens of tools, not tens.

## Project layout

```
src/
  index.ts          Workers entrypoint — Hono app, sessionless /mcp endpoint
  server.ts         McpServer factory: name/version + about resource
  tools.ts          Shared tool helpers + registration entrypoint
  tools-table.ts    Table API tools (query/get/create/update/schema)
  tools-script.ts   sn_run_script + the update-set switcher
  tools-cicd.ts     ATF suite runs + instance scans via /api/sn_cicd
  servicenow.ts     Table API + sys_trigger script runner + CI/CD helpers
.github/workflows/deploy.yml   Deploy-on-push to Cloudflare
wrangler.jsonc                  Cloudflare config
```

### The agent-safe CI/CD loop

The tools compose into a closed loop where the agent **proves its own work**:

1. `sn_switch_update_set` into a dedicated `AGENT-WORK` update set
2. Agent builds changes (create/update records, run scripts)
3. `sn_run_instance_scan` over that update set — code-quality gate
4. `sn_run_atf_suite` — functional gate (optional)
5. Human reviews the update set and ships it (or `sn validate` in the CLI way)

Every change is captured, every change is scanned, every change is tested —
by the same AI that made them.

### Adding your own tool

`src/tools.ts` is the only file you need to touch:

```ts
server.registerTool("sn_count_open_incidents", {
  description: "Count open P1 incidents",
  inputSchema: z.object({}),
}, async () => {
  const rows = await client.queryTable({
    table: "incident",
    query: "active=true^priority=1",
    fields: ["sys_id"],
    limit: 1,
  });
  return json({ open_p1s: rows.length });
});
```

## License

MIT — see [LICENSE](LICENSE). Steal this. Build something awesome.
