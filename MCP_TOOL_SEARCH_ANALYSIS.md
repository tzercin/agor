# MCP Tool Search Analysis

> Analyzing token costs of Agor's 44 MCP tools and evaluating the FastMCP "tool search" pattern to reduce per-request overhead.

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

## 4. Framework Landscape & Build vs Buy

### The Three Contenders

| Framework | npm | Stars | What It Is |
|-----------|-----|-------|-----------|
| **@modelcontextprotocol/sdk** | `@modelcontextprotocol/sdk` | Official | The official MCP SDK. Low-level, protocol-correct. |
| **FastMCP (TS)** | `fastmcp` | ~3K | Opinionated framework by punkpeye/glama. Built on Hono. |
| **mcp-framework** | `mcp-framework` | ~1K | Directory-based tool discovery, OAuth 2.1, CLI scaffolding. |

### Feature Comparison

| Feature | Our Custom Server | Official SDK | FastMCP (TS) | mcp-framework |
|---------|-------------------|-------------|-------------|---------------|
| **Tool search** | No | No | No | No |
| **Zod schemas** | No (raw JSON) | Yes | Yes | Yes |
| **Tool annotations** | No | Yes (read-only, destructive, idempotent) | Yes | Yes |
| **Streaming/SSE** | Custom (Socket.io) | Yes (Streamable HTTP) | Yes (HTTP Streaming + SSE) | Yes |
| **Notifications (list_changed)** | No | Yes (built-in) | Yes | Unclear |
| **Auth** | Custom JWT | Auth helpers | Built-in bearer/sessions | OAuth 2.1 |
| **Express integration** | Native (it IS Express) | `@modelcontextprotocol/express` middleware | Via `server.getApp()` (Hono) | Standalone only |
| **Embed in existing server** | N/A | **Yes** — mount at sub-route | **Partial** — Hono app, needs adapter | **No** — standalone process |
| **Custom HTTP routes** | Yes (FeathersJS) | Via Express app | Yes (`server.addRoute()`) | No |
| **Progress notifications** | No | Yes | Yes | No |
| **Sampling/elicitation** | No | Yes (server-initiated) | Yes | No |
| **Edge runtime** | No | No | Yes (Cloudflare Workers) | No |

### Can They Be a "Plugin" in Our Server?

This is the key constraint — **no separate process, must mount under our existing FeathersJS/Express app**.

#### Official SDK: Yes, this works

The SDK publishes `@modelcontextprotocol/express` which provides `createMcpExpressApp()` with Host header validation. The core pattern:

```typescript
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/server/streamableHttp';

// Mount on our existing FeathersJS/Express app at /mcp
app.post('/mcp', async (req, res) => {
  const server = new McpServer({ name: 'agor', version: '0.14.3' });
  // Register tools with Zod schemas
  server.registerTool('agor_sessions_list', {
    description: 'List all sessions...',
    inputSchema: z.object({ limit: z.number().optional(), ... }),
  }, async (args) => { ... });

  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
```

This replaces our custom JSON-RPC parsing with the SDK's transport layer, while keeping everything inside the same Express process.

**Benefits beyond tool search:**
- Protocol correctness for free (JSON-RPC framing, error codes, capability negotiation)
- `notifications/tools/list_changed` built-in — needed for dynamic tool exposure
- Tool annotations (mark tools as `destructive`, `readOnlyHint`, `idempotent`) — helps agents make better choices
- Zod schema validation — catch bad inputs before they hit our services
- Progress notifications — agents can show progress for long-running operations (environment start, repo clone)
- Sampling/elicitation — server can ask the LLM questions mid-tool-execution
- Future protocol changes handled by upgrading the SDK, not patching our code

**What we'd lose:**
- Direct control over JSON-RPC parsing (but we don't need it)
- Our custom session token validation would need to wrap the SDK handler

#### FastMCP (TS): Awkward fit

FastMCP uses Hono internally, not Express. You can get the Hono app via `server.getApp()`, but mounting a Hono app inside an Express app requires an adapter. It's designed as a standalone server.

**Verdict:** Not a good fit for our "plugin" requirement. We'd be fighting the framework.

#### mcp-framework: No

Designed as a standalone process with its own CLI. No embedding API.

**Verdict:** Won't work.

### Framework Recommendation

**If we want a framework: go with the Official SDK (`@modelcontextprotocol/sdk`).**

It's the only one that cleanly mounts into our existing Express app. It gives us protocol correctness, notifications, annotations, and Zod validation — all things we'd eventually want anyway. And we'd still build tool search ourselves on top (no framework offers it).

### Updated Options

#### Option A: Add Tool Search to Our Custom Server (Minimal)

Just add `search_tools` + `call_tool` to the existing `routes.ts`. No refactoring.

| Aspect | Assessment |
|--------|-----------|
| **Effort** | Low (1-2 days) |
| **Risk** | Low — additive change |
| **Token savings** | 88-96% |
| **Framework benefits** | None |
| **Maintenance** | More custom code to maintain |

#### Option B: Migrate to Official SDK + Add Tool Search

Replace our custom JSON-RPC handler with `McpServer` from the official SDK. Add tool search on top.

| Aspect | Assessment |
|--------|-----------|
| **Effort** | Medium (3-5 days) |
| **Risk** | Medium — rewrite of handler code, but tool definitions stay similar |
| **Token savings** | 88-96% |
| **Framework benefits** | Protocol correctness, notifications, annotations, Zod, progress, sampling |
| **Maintenance** | Less custom code, SDK handles protocol evolution |

**Migration path:** The SDK's `registerTool` API is very close to our current inline definitions. Each tool becomes a `server.registerTool(name, { description, inputSchema: z.object(...) }, handler)` call. The 44 tool handlers mostly stay the same — they already dispatch to FeathersJS services.

#### Option C: Hybrid Refactor + Tool Search (Previous Recommendation)

Extract tool registry + handlers from `routes.ts`, add search layer, keep custom JSON-RPC.

| Aspect | Assessment |
|--------|-----------|
| **Effort** | Low-Medium (2-3 days) |
| **Risk** | Low — refactor, not rewrite |
| **Token savings** | 88-96% |
| **Framework benefits** | None (but cleaner code structure) |
| **Maintenance** | We own everything |

#### Option D: Official SDK + Tool Search + Phased Migration

Start with tool search on our custom server (Option A), then migrate to the SDK incrementally.

| Aspect | Assessment |
|--------|-----------|
| **Effort** | 1-2 days now, 2-3 days later |
| **Risk** | Lowest — get value immediately, migrate when ready |
| **Token savings** | 88-96% immediately |
| **Framework benefits** | Deferred but planned |

### Decision Matrix

| Criteria | Weight | Option A (Quick) | Option B (SDK) | Option C (Refactor) | Option D (Phased) |
|----------|--------|---------|---------|---------|---------|
| Time to token savings | High | ★★★ | ★★ | ★★★ | ★★★ |
| Long-term maintainability | High | ★ | ★★★ | ★★ | ★★★ |
| Protocol correctness | Medium | ★ | ★★★ | ★ | ★★★ |
| Risk | High | ★★★ | ★★ | ★★★ | ★★★ |
| Future-proofing | Medium | ★ | ★★★ | ★★ | ★★★ |
| **Total** | | 9 | 13 | 11 | **15** |

---

## 5. Recommendation

### Go with Option D: Phased — Tool Search Now, SDK Migration Later

**Why:**
- **Immediate value** — get 88-96% token savings in 1-2 days
- **Lowest risk** — additive change, no rewrite
- **Clear upgrade path** — migrate to official SDK when ready for notifications, annotations, Zod, progress
- **Best of both worlds** — don't delay token savings waiting for a larger migration

### Implementation Plan

#### Phase 1: Extract Tool Registry (1 day)

Create `apps/agor-daemon/src/mcp/tool-registry.ts`:

```typescript
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: object;
  category: string;        // for search boost
  alwaysVisible?: boolean; // exempt from search-only mode
}

export const toolRegistry: Map<string, ToolDefinition> = new Map();

// Register all 44 tools
toolRegistry.set('agor_sessions_list', {
  name: 'agor_sessions_list',
  description: 'List all sessions...',
  inputSchema: { ... },
  category: 'sessions',
});
// ... etc
```

#### Phase 2: Extract Tool Handlers (1 day)

Create `apps/agor-daemon/src/mcp/tool-handlers.ts`:

```typescript
export type ToolHandler = (
  args: Record<string, unknown>,
  context: { userId: string; sessionId: string; app: Application; db: Database }
) => Promise<MCPToolResult>;

export const toolHandlers: Map<string, ToolHandler> = new Map();

toolHandlers.set('agor_sessions_list', async (args, ctx) => {
  const query: Record<string, unknown> = {};
  if (args.limit) query.$limit = args.limit;
  // ...
  const sessions = await ctx.app.service('sessions').find({ query, ...baseParams });
  return { content: [{ type: 'text', text: JSON.stringify(sessions, null, 2) }] };
});
```

#### Phase 3: Add Tool Search (1 day)

Add two synthetic tools:

```typescript
// search_tools: searches registry by keyword
toolRegistry.set('search_tools', {
  name: 'search_tools',
  description: 'Search for available Agor tools by keyword. Returns matching tool definitions with full schemas. Use this before calling tools you haven\'t seen yet.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query (matches tool names, descriptions, parameter names)' },
      max_results: { type: 'number', description: 'Maximum results to return (default: 5)' },
    },
    required: ['query'],
  },
  category: 'meta',
  alwaysVisible: true,
});
```

Search implementation — simple substring matching is sufficient for 44 tools:

```typescript
function searchTools(query: string, maxResults = 5): ToolDefinition[] {
  const terms = query.toLowerCase().split(/\s+/);
  const scored = [...toolRegistry.values()]
    .filter(t => !t.alwaysVisible) // don't return meta tools
    .map(tool => {
      const text = `${tool.name} ${tool.description} ${JSON.stringify(tool.inputSchema)}`.toLowerCase();
      const score = terms.reduce((s, term) => s + (text.includes(term) ? 1 : 0), 0);
      return { tool, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
  return scored.map(({ tool }) => tool);
}
```

#### Phase 4: Configurable Mode (0.5 day)

Make tool search opt-in via config or per-session setting:

```typescript
// In tools/list handler:
if (toolSearchEnabled) {
  // Return only: search_tools + always_visible tools
  return tools.filter(t => t.alwaysVisible);
} else {
  // Return all tools (current behavior)
  return [...toolRegistry.values()];
}
```

Suggested `alwaysVisible` tools (most commonly needed):
- `search_tools` — tool discovery
- `agor_sessions_get_current` — session context (agents need this immediately)
- `agor_sessions_spawn` — multi-agent orchestration
- `agor_sessions_prompt` — continue/fork/subsession

#### Phase 5: Dynamic Tool Exposure via list_changed (optional, 0.5 day)

After an agent discovers tools via search, dynamically add them to the tool list and send `notifications/tools/list_changed`. This way, agents only pay the token cost for tools they actually use, and subsequent turns don't require re-searching.

### Effort Summary

| Phase | Effort | Description |
|-------|--------|-------------|
| 1. Tool Registry | 1 day | Extract definitions from routes.ts |
| 2. Tool Handlers | 1 day | Extract handlers into dispatch map |
| 3. Tool Search | 1 day | search_tools + matching logic |
| 4. Config | 0.5 day | Opt-in mode, always_visible list |
| 5. list_changed | 0.5 day | Dynamic tool exposure (optional) |
| **Total** | **3-4 days** | |

### Expected Impact

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Tokens per tools/list | ~13,000 | ~1,500 | **88% reduction** |
| Context window pressure | 6.5% | 0.75% | **5.75% reclaimed** |
| Opus cost at 10K req/day | $58.50/mo | $7.02/mo | **$51.48/mo saved** |
| Scalability | Linear growth | Constant | **Decoupled from tool count** |

---

## 6. Prototype: Tool Search Implementation

Below is a minimal working prototype that can be dropped into the existing codebase:

```typescript
// apps/agor-daemon/src/mcp/tool-search.ts

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Simple term-frequency search over tool definitions.
 * Searches tool names, descriptions, and parameter names/descriptions.
 */
export function searchTools(
  tools: ToolDef[],
  query: string,
  maxResults = 5
): ToolDef[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  if (terms.length === 0) return tools.slice(0, maxResults);

  const scored = tools.map((tool) => {
    // Build searchable text from all tool metadata
    const searchText = buildSearchText(tool).toLowerCase();

    // Score: count matching terms + bonus for name matches
    let score = 0;
    for (const term of terms) {
      if (tool.name.toLowerCase().includes(term)) score += 3; // name match = 3x weight
      if (searchText.includes(term)) score += 1;
    }
    return { tool, score };
  });

  return scored
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(({ tool }) => tool);
}

function buildSearchText(tool: ToolDef): string {
  const parts = [tool.name, tool.description];

  // Extract parameter names and descriptions from schema
  const props = (tool.inputSchema as Record<string, unknown>)?.properties;
  if (props && typeof props === 'object') {
    for (const [key, value] of Object.entries(props)) {
      parts.push(key);
      if (value && typeof value === 'object' && 'description' in value) {
        parts.push(String((value as { description: string }).description));
      }
    }
  }

  return parts.join(' ');
}

/**
 * The search_tools tool definition itself
 */
export const SEARCH_TOOLS_DEF: ToolDef = {
  name: 'agor_search_tools',
  description:
    'Search for available Agor MCP tools by keyword. Returns matching tool definitions with full parameter schemas so you can call them. Use this to discover tools before calling them. Example queries: "worktree", "session spawn", "board zone", "environment logs".',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Search query — matches against tool names, descriptions, and parameter names. Use keywords like "session", "worktree", "board", "environment", etc.',
      },
      max_results: {
        type: 'number',
        description: 'Maximum number of tool definitions to return (default: 5, max: 10)',
      },
    },
    required: ['query'],
  },
};
```

### Integration Point

In the existing `tools/list` handler in `routes.ts`, the change would be minimal:

```typescript
// Before (current):
mcpResponse = { tools: ALL_44_TOOLS };

// After (with tool search enabled):
const alwaysVisible = allTools.filter(t => ALWAYS_VISIBLE.has(t.name));
mcpResponse = { tools: [SEARCH_TOOLS_DEF, ...alwaysVisible] };

// In the tools/call handler, add:
if (name === 'agor_search_tools') {
  const results = searchTools(allTools, args.query, args.max_results ?? 5);
  mcpResponse = {
    content: [{
      type: 'text',
      text: JSON.stringify(results, null, 2),
    }],
  };
}
```

---

## Appendix: Key References

### Internal
- **Agor MCP server**: `apps/agor-daemon/src/mcp/routes.ts` (4,300 lines — tool defs + handlers)
- **MCP token auth**: `apps/agor-daemon/src/mcp/tokens.ts`
- **MCP types**: `packages/core/src/types/mcp.ts`

### External
- **FastMCP tool search docs** (Python): https://gofastmcp.com/servers/transforms/tool-search
- **FastMCP TypeScript** (punkpeye): https://github.com/punkpeye/fastmcp
- **Official MCP TypeScript SDK**: https://github.com/modelcontextprotocol/typescript-sdk
- **Official SDK server docs**: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md
- **MCP protocol spec (tools)**: https://modelcontextprotocol.io/legacy/concepts/tools
- **MCP dynamic tool discovery**: https://www.speakeasy.com/mcp/tool-design/dynamic-tool-discovery
- **mcp-framework (npm)**: https://www.npmjs.com/package/mcp-framework
- **Claude Code list_changed support**: https://github.com/anthropics/claude-code/issues/13646
