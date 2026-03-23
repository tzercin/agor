# MCP Tool Search Analysis

> Analyzing token costs of Agor's 44 MCP tools and evaluating approaches to reduce per-request context overhead.

---

## 0. TL;DR — Key Discovery

**Anthropic already shipped built-in tool search** (Jan 2026). There are actually **three layers** where tool search can happen:

| Layer | What | Agor Status |
|-------|------|-------------|
| **Claude Code (client-side)** | Auto-detects >10K tokens of MCP tools, defers loading, adds `MCPSearch` tool | **Already working** — our 44 tools (~13K tokens) trigger it automatically |
| **Messages API (`defer_loading`)** | Mark tools with `defer_loading: true` + include `tool_search_tool_regex` or `_bm25` | **Not yet used** — Agor's Agent SDK integration doesn't pass `defer_loading` |
| **MCP Server (enable/disable)** | SDK's `RegisteredTool.enable()/disable()` + `sendToolListChanged()` | **Not yet implemented** — requires SDK migration |

**Bottom line:** Claude Code sessions already benefit from tool search automatically. The remaining work is:
1. **Quick win:** Leverage `defer_loading` in the Messages API for non-Claude-Code agents (Codex, Gemini, custom)
2. **Longer term:** Migrate MCP server to Official SDK for cleaner architecture + server-side control

---

## 1. Current Token Cost Analysis

### Tool Inventory

Agor exposes **44 MCP tools** across 10 categories:

| Category | Tools | Examples |
|----------|-------|---------|
| Sessions | 9 | list, get, spawn, prompt, create, update, archive, unarchive, get_current |
| Worktrees | 8 | list, get, create, update, set_zone, archive, unarchive, delete |
| Environment | 6 | start, stop, health, logs, open_app, nuke |
| Users | 6 | list, get, get_current, update_current, update, create |
| Repos | 4 | list, get, create_remote, create_local |
| Boards | 4 | get, list, update, create |
| MCP Servers | 3 | list, auth_status, request_oauth |
| Tasks | 2 | list, get |
| Messages | 1 | list (with search) |
| Analytics | 1 | leaderboard |

### Token Cost Measurement

The tool definitions in `apps/agor-daemon/src/mcp/routes.ts` (lines 118–1228) total:

| Metric | Value |
|--------|-------|
| **Raw characters** | ~49,239 |
| **Estimated tokens** | **~13,000** (at ~3.5–4 chars/token for JSON) |
| **% of typical context** | ~6.5% of a 200K context window |

### Breakdown by Component

| Component | Chars | Tokens (est.) | % of Total |
|-----------|-------|---------------|------------|
| **JSON schemas** (properties, types, enums) | ~40,900 | ~11,700 | **83%** |
| **Descriptions** (tool + parameter) | ~7,250 | ~2,100 | **15%** |
| **Tool names** | ~1,100 | ~300 | **2%** |

**Key insight:** Schemas dominate. The `agor_boards_update` and `agor_sessions_prompt` tools alone account for disproportionate schema size due to complex nested objects and multiple enums.

### Cost Per Request

Every API call to the LLM includes all 44 tool definitions as input tokens:

| Model | Input Price | Cost per Request | 1K req/day | 10K req/day |
|-------|------------|-----------------|------------|-------------|
| Claude Sonnet 4.6 | $3/1M tokens | $0.000039 | $1.17/mo | $11.70/mo |
| Claude Opus 4.6 | $15/1M tokens | $0.000195 | $5.85/mo | $58.50/mo |

### Scaling Projection

Agor is adding tools rapidly. At current growth:

| Tools | Est. Tokens | Opus Cost/10K req/day |
|-------|------------|----------------------|
| 44 (current) | ~13,000 | $58.50/mo |
| 60 (near-term) | ~17,700 | $79.65/mo |
| 80 (medium-term) | ~23,600 | $106.20/mo |
| 100 (future) | ~29,500 | $132.75/mo |

**The real cost isn't just dollars — it's context window pressure.** At 100 tools (~30K tokens), tool definitions alone consume 15% of the context window, reducing space available for conversation history, code, and reasoning.

---

## 2. Current MCP Architecture

### Implementation Overview

Agor implements a **custom MCP server** — no framework, pure JSON-RPC 2.0 over HTTP:

```
Client (Claude Code) → POST /mcp?sessionToken=<jwt> → Express handler → JSON-RPC dispatch
```

**Key files:**
- `apps/agor-daemon/src/mcp/routes.ts` — Tool definitions + request handlers (~4,300 lines)
- `apps/agor-daemon/src/mcp/tokens.ts` — Deterministic JWT authentication
- `apps/agor-daemon/src/index.ts` — Route registration (line ~6495)

### Architecture

```
┌─────────────────────────────────────────┐
│  POST /mcp?sessionToken=xxx             │
│  ┌────────────────────────────────────┐ │
│  │ 1. Validate JWT (stateless)        │ │
│  │ 2. Parse JSON-RPC method           │ │
│  │    ├─ initialize → handshake       │ │
│  │    ├─ tools/list → return 44 tools │ │
│  │    └─ tools/call → dispatch        │ │
│  │ 3. Route to FeathersJS service     │ │
│  │ 4. Return JSON-RPC response        │ │
│  └────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

### Strengths of Current Implementation

- **Zero dependencies** — No MCP framework, just Express + JSON-RPC
- **Service reuse** — All tool handlers dispatch to existing FeathersJS services
- **Stateless auth** — Deterministic JWT, no database lookup for token validation
- **Full control** — Custom streaming, spawning, OAuth proxy, etc.

### Pain Points

- **Monolithic routes.ts** — 4,300 lines, tool definitions + handlers mixed together
- **All-or-nothing tool list** — Every `tools/list` returns all 44 tools
- **No middleware/transforms** — Can't filter, search, or compose tool sets
- **Schema duplication** — Tool input schemas defined inline, not reusable

### Dependencies

The MCP SDK (`@modelcontextprotocol/sdk@^1.27.1`) is used as a **client** only — for connecting to external MCP servers (e.g., filesystem, Sentry). The Agor MCP server itself is fully custom.

---

## 3. FastMCP Tool Search Pattern

### How It Works

FastMCP (Python) replaces the full tool catalog with **two synthetic tools**:

1. **`search_tools(query)`** — Agent searches for tools by keyword. Returns matching tool definitions with full schemas.
2. **`call_tool(name, arguments)`** — Agent calls any tool by name, even if not in the current tool list.

The original tools are hidden from `tools/list` but remain callable.

### Agent UX Flow

```
Agent receives task: "Create a new worktree for this issue"

1. Agent sees only: search_tools, call_tool (+ any "always visible" tools)
2. Agent calls: search_tools("worktree create")
3. Gets back: agor_worktrees_create definition with full schema
4. Agent calls: call_tool("agor_worktrees_create", { repoId: "...", ... })
5. Gets back: normal tool result
```

### Search Strategies

| Strategy | How It Works | Best For |
|----------|-------------|----------|
| **Regex** | Case-insensitive pattern matching on names + descriptions | Precise queries from agents |
| **BM25** | TF-IDF ranking algorithm, scores by term frequency + rarity | Natural language queries |

Both search across: tool names, descriptions, parameter names, and parameter descriptions.

### Token Savings

| Scenario | Tokens in tools/list | Savings |
|----------|---------------------|---------|
| **Current** (all 44 tools) | ~13,000 | — |
| **Tool search** (2 synthetic tools) | ~500 | **96%** |
| **Tool search + 3 always-visible** | ~1,500 | **88%** |

The tradeoff: agents need 1 extra round-trip to discover tools before using them. In practice, agents quickly learn to search first and most tasks only need 2-5 tools.

### MCP Protocol Support

The MCP spec supports **`notifications/tools/list_changed`** — servers can dynamically update their tool list mid-session. Claude Code already handles this notification, re-fetching `tools/list` when received.

This means we could implement a hybrid approach: start with search tools, then dynamically expose discovered tools for the remainder of the session.

---

## 4. Anthropic's Built-In Tool Search (The Game Changer)

### What Shipped

Anthropic rolled out **built-in tool search** in January 2026 at two levels:

#### Level 1: Claude Code Auto-Search (Client-Side)

Claude Code **automatically** enables tool search when MCP tool definitions exceed ~10K tokens:

1. Detects total MCP tool token count > 10K threshold
2. Marks tools with `defer_loading: true` internally
3. Injects an `MCPSearch` tool into the agent's tool set
4. Claude discovers tools on-demand via search, then calls them natively
5. **No server-side changes needed** — works with any MCP server

**Agor already benefits from this.** Our 44 tools (~13K tokens) exceed the 10K threshold, so Claude Code sessions are already using tool search. Benchmarks show 85%+ token reduction.

#### Level 2: Messages API `defer_loading` (Server-Side)

For direct API usage (not through Claude Code), you can explicitly opt tools into deferred loading:

```typescript
// In the Messages API tools array:
{
  name: "get_weather",
  description: "Get current weather for a location",
  input_schema: { ... },
  defer_loading: true  // ← This tool won't be loaded into context until searched
}
```

Plus include a search tool:
```typescript
{ type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" }
```

The API handles everything — deferred tools don't count against input tokens, search happens server-side at Anthropic, `tool_reference` blocks auto-expand to full definitions.

Two search strategies:
- **Regex** (`tool_search_tool_regex_20251119`) — Claude constructs regex patterns
- **BM25** (`tool_search_tool_bm25_20251119`) — Natural language queries, ranked by relevance

#### Level 3: Custom Client-Side Search

You can implement your own search (embeddings, semantic, etc.) by returning `tool_reference` blocks:

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_xxx",
  "content": [{ "type": "tool_reference", "tool_name": "discovered_tool_name" }]
}
```

Referenced tools must have `defer_loading: true` in the `tools` array. The API auto-expands references into full definitions.

#### MCP-Specific Integration

For MCP servers specifically, there's `mcp_toolset` with bulk defer:

```typescript
{
  type: "mcp_toolset",
  mcp_server_name: "agor",
  default_config: { defer_loading: true },  // Defer ALL tools by default
  configs: {
    agor_sessions_get_current: { defer_loading: false },  // Keep essentials visible
    agor_sessions_spawn: { defer_loading: false },
  }
}
```

### What This Means for Agor

| Agent Type | Current State | Action Needed |
|-----------|---------------|---------------|
| **Claude Code** sessions | Auto tool search already working | None — already saving ~85% tokens |
| **Claude Agent SDK** sessions | Full tool definitions sent every turn | Pass `defer_loading: true` via SDK options |
| **Codex / Gemini** sessions | No Anthropic tool search available | Server-side search still valuable |

**The urgency of building our own tool search is lower than initially thought.** Claude Code already handles it. The remaining value is:
1. Better architecture (SDK migration, split `routes.ts` monolith)
2. Server-side search for non-Claude agents
3. Tool annotations, Zod validation, progress notifications

---

## 5. MCP Server Framework Landscape

### The Three Contenders

| Framework | npm | What It Is | Embed in Express? |
|-----------|-----|-----------|-------------------|
| **@modelcontextprotocol/sdk** | `@modelcontextprotocol/sdk` | Official MCP SDK. Protocol-correct, low-level. | **Yes** — Express middleware |
| **FastMCP (TS)** | `fastmcp` | Opinionated framework (punkpeye/glama). Built on Hono. | **No** — Hono app, needs adapter |
| **mcp-framework** | `mcp-framework` | Directory-based tool discovery, CLI scaffolding. | **No** — standalone process |

FastMCP and mcp-framework are non-starters for our "plugin" constraint — they require their own process. **The Official SDK is the only option that mounts cleanly into our existing FeathersJS/Express app.**

### Does the SDK Offer Tool Search?

**No built-in tool search.** No framework in any language ships tool search — FastMCP (Python) is the only one, and even there it's a "transform" add-on, not core.

**But the SDK gives us the perfect primitives to build it:**

The `RegisteredTool` object returned by `registerTool()` has:

```typescript
interface RegisteredTool {
  // Metadata
  title?: string;
  description?: string;
  inputSchema?: AnySchema;       // Zod schema
  outputSchema?: AnySchema;      // Zod schema
  annotations?: ToolAnnotations; // { readOnlyHint, destructiveHint, idempotentHint, openWorldHint }
  _meta?: Record<string, unknown>; // Custom metadata (categories, search tags, etc.)

  // Lifecycle — THE KEY PRIMITIVES
  enabled: boolean;
  enable(): void;   // Make tool visible in tools/list
  disable(): void;  // Hide tool from tools/list (but keep registered)
  remove(): void;   // Fully unregister

  // Hot update without re-registration
  update(updates: {
    name?: string;
    description?: string;
    paramsSchema?: ZodSchema;
    annotations?: ToolAnnotations;
    callback?: ToolCallback;
    enabled?: boolean;
  }): void;
}
```

Plus `McpServer` exposes:

```typescript
class McpServer {
  sendToolListChanged(): void;  // Notify client to re-fetch tools/list
  sendResourceListChanged(): void;
  sendPromptListChanged(): void;
  // ...
}
```

**The pattern becomes:** register all 44 tools but `disable()` most of them. Register `search_tools` as always-enabled. When an agent searches, `enable()` the matching tools and call `sendToolListChanged()`. The SDK handles the protocol notification — the client re-fetches the tool list and now sees the discovered tools natively.

This is **better than FastMCP's approach** because:
- No `call_tool` proxy needed — discovered tools become real tools in the client
- Agents see proper tool definitions with full schemas after discovery
- No extra indirection layer
- Works with any MCP client, not just ones that understand a custom `call_tool` convention

### Feature Comparison: What We Gain

| Feature | Our Custom Server | Official SDK |
|---------|-------------------|-------------|
| **Tool search** | No | No (but `enable()/disable()/sendToolListChanged()` makes it trivial) |
| **Zod schema validation** | No (raw JSON, no validation) | Yes — invalid inputs caught before handler |
| **Tool annotations** | No | `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` |
| **Output schemas** | No | Yes — structured responses with validation |
| **Dynamic tool visibility** | No | `enable()` / `disable()` + `sendToolListChanged()` |
| **Hot tool updates** | No | `tool.update({ description, schema, ... })` without re-register |
| **Progress notifications** | No | Yes — agents see progress for long ops (env start, repo clone) |
| **Logging** | Console only | `ctx.mcpReq.log('info', ...)` — structured logging to client |
| **Sampling/elicitation** | No | Server can ask the LLM questions mid-tool |
| **Custom tool metadata** | No | `_meta` field — categories, search keywords, anything |
| **Protocol evolution** | Manual patches | SDK upgrade |
| **JSON-RPC handling** | Custom (500+ lines) | SDK handles framing, errors, capabilities |
| **Express integration** | Native | `@modelcontextprotocol/express` middleware at sub-route |

### What We Lose

- Direct control over JSON-RPC parsing (but we don't need it — it's boilerplate)
- Our custom session token validation wraps the SDK handler (straightforward)
- Some familiarity with the current monolithic code

---

## 6. Recommendation: Migrate to Official SDK

### Why still migrate if Claude Code already has tool search?

**Tool search is solved at the client layer for Claude Code.** But the SDK migration is still the right move because:

1. **Architecture** — `routes.ts` is 4,300 lines of mixed definitions + handlers. The SDK gives us a natural 1-tool-per-`registerTool()` decomposition into 10 focused domain files.
2. **Non-Claude agents** — Codex, Gemini, and custom agents don't benefit from Claude Code's auto-search. Server-side `enable()/disable()/sendToolListChanged()` serves them.
3. **Tool annotations** — `readOnlyHint`, `destructiveHint`, `idempotentHint` help ALL agents make safer choices.
4. **Zod validation** — Catch bad inputs before they hit FeathersJS services.
5. **Progress notifications** — Environment start, repo clone, etc. can report progress to agents.
6. **Protocol correctness** — SDK handles JSON-RPC framing, error codes, capability negotiation. We delete ~500 lines of custom protocol code.
7. **Future-proofing** — SEP-1821 (dynamic tool discovery via `query` param in `tools/list`) is in draft. The SDK will implement it; our custom code won't.

### Implementation Plan

#### Phase 1: SDK Scaffolding + Express Mount (0.5 day)

Replace the custom JSON-RPC handler with the SDK's `McpServer`, mounted at the same `/mcp` endpoint.

```typescript
// apps/agor-daemon/src/mcp/server.ts

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export function createAgorMcpServer() {
  return new McpServer(
    { name: 'agor', version: '0.15.0' },
    { capabilities: { tools: { listChanged: true }, logging: {} } }
  );
}
```

Mount in `apps/agor-daemon/src/index.ts`:

```typescript
app.post('/mcp', async (req, res) => {
  const sessionToken = req.query.sessionToken as string;
  const context = await validateSessionToken(app, sessionToken);
  if (!context) return res.status(401).json({ ... });

  const server = createAgorMcpServer();
  registerAllTools(server, { app, db, context });

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
```

**Deliverable:** SDK serving the same tools, passing existing behavior tests.

#### Phase 2: Migrate Tool Definitions + Handlers (2-3 days)

Convert all 44 tools from inline JSON to `registerTool()` with Zod schemas. Group by domain into separate files:

```
apps/agor-daemon/src/mcp/
├── server.ts              # McpServer factory + Express mount
├── tools/
│   ├── sessions.ts        # 9 session tools
│   ├── worktrees.ts       # 8 worktree tools
│   ├── environment.ts     # 6 environment tools
│   ├── users.ts           # 6 user tools
│   ├── repos.ts           # 4 repo tools
│   ├── boards.ts          # 4 board tools
│   ├── mcp-servers.ts     # 3 MCP server tools
│   ├── tasks.ts           # 2 task tools
│   ├── messages.ts        # 1 message tool
│   ├── analytics.ts       # 1 analytics tool
│   └── search.ts          # search_tools (Phase 3)
├── tokens.ts              # JWT auth (unchanged)
└── routes.ts              # DELETED after migration
```

Each tool file exports a `register` function:

```typescript
// apps/agor-daemon/src/mcp/tools/sessions.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerSessionTools(server: McpServer, ctx: ToolContext) {
  server.registerTool('agor_sessions_list', {
    description: 'List all sessions accessible to the current user.',
    inputSchema: z.object({
      limit: z.number().optional().describe('Maximum number of sessions to return (default: 50)'),
      status: z.enum(['idle', 'running', 'completed', 'failed']).optional().describe('Filter by session status'),
      boardId: z.string().optional().describe('Filter sessions by board ID (UUIDv7 or short ID)'),
      worktreeId: z.string().optional().describe('Filter sessions by worktree ID'),
      includeArchived: z.boolean().optional().describe('Include archived sessions in results (default: false)'),
      archived: z.boolean().optional().describe('Filter to show ONLY archived sessions'),
    }),
    annotations: { readOnlyHint: true },
  }, async (args) => {
    const query = {};
    if (args.limit) query.$limit = args.limit;
    // ... existing handler logic, unchanged
    const sessions = await ctx.app.service('sessions').find({ query, ...ctx.baseParams });
    return { content: [{ type: 'text', text: JSON.stringify(sessions, null, 2) }] };
  });

  server.registerTool('agor_sessions_spawn', {
    description: 'Spawn a child session for delegating work to another agent.',
    inputSchema: z.object({
      prompt: z.string().describe('The prompt/task for the subsession agent to execute'),
      title: z.string().optional().describe('Optional title for the session'),
      agenticTool: z.enum(['claude-code', 'codex', 'gemini', 'opencode']).optional(),
      enableCallback: z.boolean().optional().describe('Enable callback to parent on completion (default: true)'),
      // ...
    }),
    annotations: { destructiveHint: false, idempotentHint: false },
  }, async (args) => {
    // ... existing spawn handler
  });

  // ... 7 more session tools
}
```

**Key annotation decisions:**

| Tool Category | Annotations |
|--------------|------------|
| All `*_list`, `*_get`, `*_get_current` | `readOnlyHint: true` |
| `*_create`, `*_spawn` | `destructiveHint: false` |
| `*_update`, `*_set_zone` | `destructiveHint: false, idempotentHint: true` |
| `*_archive`, `*_delete`, `*_nuke` | `destructiveHint: true` |
| `environment_start/stop` | `idempotentHint: true` |

**Deliverable:** `routes.ts` replaced by `server.ts` + 10 domain files. All 44 tools registered with Zod schemas and annotations.

#### Phase 3: Add Tool Search (1 day)

Register `agor_search_tools` as an always-enabled tool. All other tools start disabled.

```typescript
// apps/agor-daemon/src/mcp/tools/search.ts
import { z } from 'zod';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';

// Tools that are always visible (no search needed)
const ALWAYS_VISIBLE = new Set([
  'agor_search_tools',
  'agor_sessions_get_current',
  'agor_sessions_spawn',
  'agor_sessions_prompt',
]);

export function registerSearchTool(
  server: McpServer,
  allTools: Map<string, { def: ToolDefinition; registered: RegisteredTool }>
) {
  server.registerTool('agor_search_tools', {
    description: [
      'Search for available Agor MCP tools by keyword.',
      'Returns matching tool definitions with full parameter schemas.',
      'After searching, matching tools become available for direct use.',
      'Example queries: "worktree create", "session spawn", "board zone", "environment logs".',
    ].join(' '),
    inputSchema: z.object({
      query: z.string().describe('Search keywords (matches tool names, descriptions, parameters)'),
      max_results: z.number().min(1).max(20).optional().describe('Max results (default: 5)'),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ query, max_results }) => {
    const results = searchTools([...allTools.values()].map(t => t.def), query, max_results ?? 5);

    // Enable discovered tools so they appear in subsequent tools/list
    for (const result of results) {
      const tool = allTools.get(result.name);
      if (tool && !tool.registered.enabled) {
        tool.registered.enable();
      }
    }

    // Notify client that tool list has changed
    if (results.length > 0) {
      server.sendToolListChanged();
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(results.map(r => ({
          name: r.name,
          description: r.description,
          inputSchema: r.inputSchema,
        })), null, 2),
      }],
    };
  });

  // Disable non-essential tools initially
  for (const [name, tool] of allTools) {
    if (!ALWAYS_VISIBLE.has(name)) {
      tool.registered.disable();
    }
  }
}
```

The search logic itself — simple weighted substring matching:

```typescript
function searchTools(tools: ToolDefinition[], query: string, maxResults: number): ToolDefinition[] {
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
  if (terms.length === 0) return tools.slice(0, maxResults);

  return tools
    .map(tool => {
      const nameText = tool.name.toLowerCase();
      const descText = tool.description.toLowerCase();
      const schemaText = JSON.stringify(tool.inputSchema).toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (nameText.includes(term)) score += 3;
        if (descText.includes(term)) score += 2;
        if (schemaText.includes(term)) score += 1;
      }
      return { tool, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(({ tool }) => tool);
}
```

**Agent UX flow with `enable()` + `sendToolListChanged()`:**

```
Turn 1: Agent sees tools → [agor_search_tools, agor_sessions_get_current, agor_sessions_spawn, agor_sessions_prompt]
         Agent calls: agor_search_tools({ query: "worktree create" })
         Server: enables agor_worktrees_create, agor_worktrees_list, sends list_changed
         Returns: matching tool definitions

Turn 2: Client re-fetches tools/list → now sees worktree tools as REAL tools
         Agent calls: agor_worktrees_create({ repoId: "...", ... })  ← native tool call, no proxy!
```

This is **strictly better than FastMCP's `call_tool` proxy** — discovered tools become first-class citizens in the client.

**Deliverable:** Tool search working, agents see only 4 tools initially, discovered tools materialize as real tools.

#### Phase 4: Configuration + Polish (0.5 day)

Make tool search mode configurable:

```yaml
# ~/.agor/config.yaml
mcp:
  tool_search: true         # Enable search mode (default: true for new installs)
  always_visible:            # Override default always-visible tools
    - agor_search_tools
    - agor_sessions_get_current
    - agor_sessions_spawn
    - agor_sessions_prompt
```

Add a fallback: if `tool_search: false`, all tools are enabled (current behavior). Existing users aren't affected.

**Deliverable:** Opt-in/opt-out config, backwards compatible.

### Effort Summary

| Phase | Effort | What |
|-------|--------|------|
| 1. SDK Scaffolding | 0.5 day | McpServer + Express mount, same endpoint |
| 2. Tool Migration | 2-3 days | 44 tools → Zod schemas + annotations, split into 10 domain files |
| 3. Tool Search | 1 day | `agor_search_tools` + `enable()/disable()/sendToolListChanged()` |
| 4. Config + Polish | 0.5 day | Config flag, always_visible override, backwards compat |
| **Total** | **4-5 days** |

### Expected Impact

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Tokens per tools/list | ~13,000 | ~1,500 (4 always-visible) | **88% reduction** |
| Context window pressure | 6.5% | 0.75% | **5.75% reclaimed** |
| Opus cost at 10K req/day | $58.50/mo | $7.02/mo | **$51.48/mo saved** |
| Scalability | Linear growth | Constant | **Decoupled from tool count** |
| routes.ts | 4,300 lines (monolith) | Deleted | **10 focused domain files** |
| Input validation | None | Zod schemas | **Bad inputs caught early** |
| Agent safety hints | None | Tool annotations | **Agents know which tools are destructive** |
| Protocol correctness | Best-effort | SDK-guaranteed | **Future-proof** |

---

## 7. Why Our Server-Side Approach Is Better Than FastMCP's

FastMCP (Python) uses a `call_tool` proxy — agents discover tools via search, then call them indirectly through a generic proxy tool. The SDK's `enable()`/`disable()` + `sendToolListChanged()` pattern is strictly better:

| Aspect | FastMCP `call_tool` Proxy | SDK `enable()` + `sendToolListChanged()` |
|--------|--------------------------|----------------------------------------|
| **Tool calling** | Indirect via `call_tool(name, args)` | Native tool calls — full schema in client |
| **Schema validation** | Proxy validates | SDK validates with Zod before handler |
| **Client compatibility** | Custom convention | Standard MCP protocol |
| **Agent experience** | Must remember tool names from search results | Tools appear as real tools after search |
| **Extra round-trips** | 1 (search) + proxy overhead per call | 1 (search) + auto-refresh via list_changed |
| **Annotation support** | No | Yes — destructive/readonly hints on discovered tools |

The key insight: **discovered tools become first-class tools** in the client. No proxy, no indirection, no custom conventions. The MCP protocol's `list_changed` notification is the right abstraction.

---

## Appendix: Key References

### Internal
- **Agor MCP server**: `apps/agor-daemon/src/mcp/routes.ts` (4,300 lines — tool defs + handlers)
- **MCP token auth**: `apps/agor-daemon/src/mcp/tokens.ts`
- **MCP types**: `packages/core/src/types/mcp.ts`

### Anthropic Tool Search (Built-In)
- **Tool Search Tool docs**: https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
- **Advanced tool use (engineering blog)**: https://www.anthropic.com/engineering/advanced-tool-use
- **Code execution with MCP**: https://www.anthropic.com/engineering/code-execution-with-mcp
- **Claude Code MCP tool search**: https://www.atcyrus.com/stories/mcp-tool-search-claude-code-context-pollution-guide

### MCP Protocol & SDK
- **Official MCP TypeScript SDK**: https://github.com/modelcontextprotocol/typescript-sdk
- **SEP-1821: Dynamic Tool Discovery** (draft): https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1821
- **SEP-1888: Progressive Disclosure** (draft): https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1888
- **MCP protocol spec (tools)**: https://modelcontextprotocol.io/legacy/concepts/tools

### Third-Party Approaches
- **FastMCP tool search docs** (Python): https://gofastmcp.com/servers/transforms/tool-search
- **FastMCP TypeScript** (punkpeye): https://github.com/punkpeye/fastmcp
- **Speakeasy dynamic toolsets** (100x reduction): https://www.speakeasy.com/blog/how-we-reduced-token-usage-by-100x-dynamic-toolsets-v2
- **mcp2cli** (96-99% reduction): https://jangwook.net/en/blog/en/mcp2cli-token-cost-optimization/
- **ToolHive MCP Optimizer**: https://dev.to/stacklok/cut-token-waste-from-your-ai-workflow-with-the-toolhive-mcp-optimizer-3oo6
- **Redis tool filtering** (98% reduction): https://redis.io/blog/from-reasoning-to-retrieval-solving-the-mcp-tool-overload-problem/
