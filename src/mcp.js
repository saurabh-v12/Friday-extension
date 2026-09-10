// MCP (Model Context Protocol) client — Task 6.1.
//
// Chrome extensions can't spawn stdio subprocesses, so this client only
// speaks the HTTP transport variant of MCP: JSON-RPC 2.0 requests posted
// to a server URL. Method shapes match the MCP spec:
//   • initialize                → server capabilities
//   • tools/list                → available tools with input JSON schema
//   • tools/call {name, args}   → invoke a tool, return {content:[…]}
//
// PII scrub happens BEFORE args cross the wire (Task 6.2 privacy boundary):
// every string in args runs through the same PATTERNS from pii.js, and any
// hit is replaced with `redactShort()` output. Objects are walked
// recursively; non-strings pass through.

import { PATTERNS, PII_KIND } from "./pii.js";

let _idCounter = 0;
function nextId() { return `friday-${Date.now()}-${++_idCounter}`; }

async function rpc(url, method, params, { headers = {}, timeoutMs = 15000 } = {}) {
  const body = { jsonrpc: "2.0", id: nextId(), method };
  if (params !== undefined) body.params = params;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`MCP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    if (data.error) {
      const e = data.error;
      throw new Error(`MCP error ${e.code}: ${e.message || "unknown"}`);
    }
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

export class MCPClient {
  constructor({ url, name = "mcp", headers = {} } = {}) {
    if (!url) throw new Error("MCPClient: url required");
    this.url = url;
    this.name = name;
    this.headers = headers;
    this.capabilities = null;
    this.tools = null;
  }

  async initialize({ clientName = "Friday", clientVersion = "0.0.1" } = {}) {
    const res = await rpc(this.url, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: clientName, version: clientVersion },
    }, { headers: this.headers });
    this.capabilities = res.capabilities || {};
    return res;
  }

  async listTools() {
    const res = await rpc(this.url, "tools/list", {}, { headers: this.headers });
    this.tools = (res && res.tools) || [];
    return this.tools;
  }

  async callTool(name, args = {}) {
    const safeArgs = scrubPii(args);
    const res = await rpc(this.url, "tools/call", { name, arguments: safeArgs }, { headers: this.headers, timeoutMs: 30000 });
    return {
      content: res.content || [],
      isError: !!res.isError,
      sentArgs: safeArgs,
    };
  }
}

// ─── PII scrub for tool args (6.2 boundary) ──────────────────────────

function redactShort(kind, val) {
  if (kind === PII_KIND.EMAIL) {
    const m = val.match(PATTERNS.email);
    if (!m) return "***@***";
    const [local, domain] = m[0].split("@");
    return `${local[0] || "*"}***@${domain}`;
  }
  if (kind === PII_KIND.AADHAAR) return "****-****-****";
  if (kind === PII_KIND.PAN) return "*****####*";
  if (kind === PII_KIND.SSN) return "***-**-****";
  if (kind === PII_KIND.CC) return "**** **** **** ####";
  if (kind === PII_KIND.PHONE) return "*** *** ****";
  return "***";
}

function scrubString(s) {
  let out = s;
  const tests = [
    { rx: PATTERNS.email, kind: PII_KIND.EMAIL },
    { rx: PATTERNS.aadhaar, kind: PII_KIND.AADHAAR },
    { rx: PATTERNS.pan, kind: PII_KIND.PAN },
    { rx: PATTERNS.ssn, kind: PII_KIND.SSN },
    { rx: PATTERNS.cc, kind: PII_KIND.CC },
    { rx: PATTERNS.phoneIn, kind: PII_KIND.PHONE },
    { rx: PATTERNS.phoneUs, kind: PII_KIND.PHONE },
  ];
  for (const { rx, kind } of tests) {
    out = out.replace(new RegExp(rx.source, "g"), () => redactShort(kind, "***"));
  }
  return out;
}

// Walk any JSON-shaped value and redact strings.
export function scrubPii(val) {
  if (val == null) return val;
  if (typeof val === "string") return scrubString(val);
  if (Array.isArray(val)) return val.map(scrubPii);
  if (typeof val === "object") {
    const out = {};
    for (const [k, v] of Object.entries(val)) out[k] = scrubPii(v);
    return out;
  }
  return val;
}

// ─── Manager: list of registered servers + a tools directory ─────────

export class MCPManager {
  constructor(servers = []) {
    this.clients = new Map();
    for (const s of servers) {
      if (!s || !s.url || s.enabled === false) continue;
      this.clients.set(s.name || s.url, new MCPClient(s));
    }
  }

  names() { return Array.from(this.clients.keys()); }

  async initAll() {
    const out = [];
    for (const [name, client] of this.clients.entries()) {
      try {
        await client.initialize();
        await client.listTools();
        out.push({ name, ok: true, toolCount: client.tools.length });
      } catch (err) {
        out.push({ name, ok: false, error: err.message });
      }
    }
    return out;
  }

  // Flat list of {server, tool} entries for the router prompt.
  allTools() {
    const out = [];
    for (const [name, client] of this.clients.entries()) {
      for (const t of client.tools || []) out.push({ server: name, tool: t });
    }
    return out;
  }

  async callTool(serverName, toolName, args) {
    const client = this.clients.get(serverName);
    if (!client) throw new Error(`MCP: unknown server "${serverName}"`);
    return client.callTool(toolName, args);
  }
}
