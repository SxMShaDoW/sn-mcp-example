/**
 * MCP tool definitions for the ServiceNow example server.
 *
 * Each tool is registered on an McpServer instance from
 * `@modelcontextprotocol/server` with a zod input schema. Tools return text
 * content; errors are reported with `isError: true` so the agent can read the
 * message and self-correct instead of the transport failing.
 *
 * Tool families:
 * - Table API: query / get / create / update records, live schema discovery
 * - Run Script: one-shot `sys_trigger` GlideRecord execution (the update-set
 *   switcher is built on it)
 * - CI/CD: ATF test suite runs and instance-scan suite scans via
 *   `/api/sn_cicd/*`, with progress polling
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ServiceNowClient, val } from "./servicenow.js";
import { registerTableTools } from "./tools-table.js";
import { registerScriptTools } from "./tools-script.js";
import { registerCicdTools } from "./tools-cicd.js";

export type { ServiceNowClient } from "./servicenow.js";

export function registerAllTools(server: McpServer, client: ServiceNowClient): ToolRef[] {
	return [
		...registerTableTools(server, client),
		...registerScriptTools(server, client),
		...registerCicdTools(server, client),
	];
}

/** Shared helpers for tool modules. */

import type { RegisteredTool } from "@modelcontextprotocol/server";
export type ToolRef = RegisteredTool;

export function json(result: unknown): { content: [{ type: "text"; text: string }] } {
	return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

export function toolError(err: unknown): {
	content: [{ type: "text"; text: string }];
	isError: true;
} {
	const message = err instanceof Error ? err.message : String(err);
	return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/** Normalize ServiceNow's `"field": { "value": ..., "display_value": ... }` envelope. */
export function displayVal(v: unknown): string {
	if (typeof v === "object" && v !== null && "value" in (v as Record<string, unknown>)) {
		const kv = v as { value?: unknown; display_value?: unknown };
		return String(kv.display_value || (kv.value ?? ""));
	}
	return String(v ?? "");
}

/** Compact a raw Table API record into a friendlier shape for the model. */
export function summarizeRecord(record: Record<string, unknown>, display: boolean): Record<string, unknown> {
	const out: Record<string, unknown> = { sys_id: record.sys_id };
	for (const [key, raw] of Object.entries(record)) {
		if (key === "sys_id") continue;
		out[key] = display ? displayVal(raw) : raw;
	}
	return out;
}

// Re-exported for callers that imported these from tools.ts before the split.
export { val };
