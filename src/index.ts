/**
 * Cloudflare Workers entrypoint.
 *
 * Sessionless / Streamable HTTP: the server holds no per-session state, so
 * every POST to /mcp is handled independently. That is the simplest MCP
 * transport to host on stateless infrastructure — no Durable Objects, no
 * session store, nothing to evict. It is what "sessionless MCP" means in
 * practice, and it works with every Streamable-HTTP-capable MCP client
 * (Claude Code, Claude Desktop connectors, Cursor, the MCP Inspector).
 *
 * GET /mcp is rejected with 405: Streamable HTTP servers that keep no session
 * state have nothing meaningful to return for an SSE stream, and answering
 * 405 explicitly is what the transport spec recommends.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { ServiceNowClient } from "./servicenow.js";
import { createServer } from "./server.js";

export interface Env {
	SN_INSTANCE?: string;
	SN_USERNAME?: string;
	SN_PASSWORD?: string;
	SN_TOKEN?: string;
}

type Variables = { client: ServiceNowClient };

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use("/mcp", cors());

/** MCP methods that must work even when the server has no SN credentials yet. */
const FREE_METHODS = new Set(["initialize", "tools/list", "notifications/initialized"]);

app.use("/mcp", async (c, next) => {
	// Free-path: discovery requests short-circuit before credential checks so
	// any MCP client can inspect the server before configuring it.
	const methodHeader = c.req.header("mcp-method");
	if (methodHeader && FREE_METHODS.has(methodHeader)) return next();
	try {
		const body = (await c.req.raw.clone().json()) as { method?: string } | null;
		if (body?.method && FREE_METHODS.has(body.method)) return next();
	} catch {
		// Not JSON — fall through to credential checks.
	}

	let instance = c.env.SN_INSTANCE;
	if (instance && !/^https?:\/\//.test(instance)) {
		// Accept bare instance names for convenience (dev000000 -> https://dev000000.service-now.com)
		instance = `https://${instance}.service-now.com`;
	}

	const auth = c.env.SN_TOKEN
		? ({ type: "bearer", token: c.env.SN_TOKEN } as const)
		: c.env.SN_USERNAME && c.env.SN_PASSWORD
			? ({ type: "basic", username: c.env.SN_USERNAME, password: c.env.SN_PASSWORD } as const)
			: undefined;

	if (!instance || !auth) {
		return c.json(
			{
				error:
					"Server is missing ServiceNow configuration. Set SN_INSTANCE and either " +
					"SN_USERNAME+SN_PASSWORD or SN_TOKEN. Locally: copy .dev.vars.example to .dev.vars. " +
					"Remotely: `wrangler secret put SN_INSTANCE` etc.",
			},
			503,
		);
	}

	c.set("client", new ServiceNowClient({ instance, auth }));
	return next();
});

/** Build a handler bound to the env-configured client, or a discovery-only one. */
function mcpHandlerFor(env: Env) {
	const discoveryOnly = !env.SN_INSTANCE || (!env.SN_TOKEN && !(env.SN_USERNAME && env.SN_PASSWORD));
	return createMcpHandler(() => {
		if (discoveryOnly) {
			// No credentials configured yet: discovery works, but every tool is
			// disabled so agents see "server not configured" instead of a confusing
			// ServiceNow auth failure on first call.
			const { server, tools } = createServer(
				new ServiceNowClient({
					instance: "https://unset.invalid",
					auth: { type: "bearer", token: "unset" },
				}),
			);
			for (const tool of tools) tool.disable();
			return server;
		}
		return createServer(clientFromEnv(env)).server;
	});
}

function clientFromEnv(env: Env): ServiceNowClient {
	let instance = env.SN_INSTANCE as string;
	if (!/^https?:\/\//.test(instance)) {
		instance = `https://${instance}.service-now.com`;
	}
	const auth = env.SN_TOKEN
		? ({ type: "bearer", token: env.SN_TOKEN } as const)
		: { type: "basic" as const, username: env.SN_USERNAME as string, password: env.SN_PASSWORD as string };
	return new ServiceNowClient({ instance, auth });
}

app.post("/mcp", async (c) => {
	const handler = mcpHandlerFor(c.env);
	try {
		return await handler.fetch(c.req.raw);
	} finally {
		await handler.close();
	}
});

app.get("/mcp", (c) =>
	c.json(
		{
			error: "This server is sessionless (Streamable HTTP, POST only). Use POST for all MCP requests.",
		},
		405,
	),
);

// GET / — tiny human-readable landing so the worker URL isn't a dead end in a demo.
app.get("/", (c) =>
	c.html(
		`<html><body style="font-family: system-ui; max-width: 40rem; margin: 4rem auto; line-height: 1.6">
<h1>ServiceNow MCP Example</h1>
<p>A sessionless (Streamable HTTP) Model Context Protocol server for ServiceNow,
running on Cloudflare Workers. Point an MCP client at <code>/mcp</code>.</p>
<p><strong>Health check:</strong> POST an MCP <code>initialize</code> request to <code>/mcp</code>.</p>
<p>Source &amp; setup: see the repository README.</p>
</body></html>`,
	),
);

export default app;
