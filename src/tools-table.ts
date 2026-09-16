/**
 * Table API tools: query, get, create, update, and live schema discovery.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ServiceNowClient } from "./servicenow.js";
import type { ToolRef } from "./tools.js";
import { json, toolError, summarizeRecord } from "./tools.js";

const QUERY_LIMITS = { min: 1, max: 100 } as const;

export function registerTableTools(server: McpServer, client: ServiceNowClient): ToolRef[] {
	const tools: ToolRef[] = [];

	tools.push(
		server.registerTool(
		"sn_query_records",
		{
			title: "Query ServiceNow records",
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			description:
				"Query records from a ServiceNow table using an encoded query. " +
				"Example query: 'active=true^priority=1^ORDERBYDESCsys_created_on'. " +
				"Use sn_get_table_schema first if you are unsure which fields exist.",
			inputSchema: z.object({
				table: z.string().describe("Table name, e.g. incident, change_request, cmdb_ci"),
				query: z.string().optional().describe("Encoded query string"),
				fields: z.array(z.string()).optional().describe("Fields to return (fewer = faster)"),
				limit: z.number().int().min(QUERY_LIMITS.min).max(QUERY_LIMITS.max).default(10),
				offset: z.number().int().min(0).default(0),
				displayValue: z
					.enum(["true", "false", "all"])
					.default("false")
					.describe("true shows human-readable values for reference fields"),
			}),
		},
		async ({ table, query, fields, limit, offset, displayValue }) => {
			try {
				const display = displayValue === "true";
				const records = (await client.queryTable({
					table,
					query,
					fields:
						fields ?? (display ? undefined : ["sys_id", "number", "short_description", "state"]),
					limit,
					offset,
					displayValue,
				})) as Record<string, unknown>[];
				return json({
					count: records.length,
					records: records.map((r) => summarizeRecord(r, display)),
				});
			} catch (err) {
				return toolError(err);
			}
		},
		),
	);

	tools.push(
		server.registerTool(
		"sn_get_record",
		{
			title: "Get a ServiceNow record",
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			description: "Fetch a single record by sys_id from any table.",
			inputSchema: z.object({
				table: z.string().describe("Table name"),
				sys_id: z.string().describe("32-character sys_id of the record"),
			}),
		},
		async ({ table, sys_id }) => {
			try {
				return json(await client.getRecord(table, sys_id));
			} catch (err) {
				return toolError(err);
			}
		},
		),
	);

	tools.push(
		server.registerTool(
		"sn_create_record",
		{
			title: "Create a ServiceNow record",
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: false,
			},
			description: "Create a new record in a table. Only send fields that exist on the table.",
			inputSchema: z.object({
				table: z.string().describe("Table name, e.g. incident"),
				fields: z
					.record(z.string(), z.string())
					.describe('Field values, e.g. {"short_description": "Laptop won\'t boot"}'),
			}),
		},
		async ({ table, fields }) => {
			try {
				return json(await client.upsertRecord(table, fields));
			} catch (err) {
				return toolError(err);
			}
		},
		),
	);

	tools.push(
		server.registerTool(
		"sn_update_record",
		{
			title: "Update a ServiceNow record",
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			description: "Update an existing record by sys_id. Only send the fields you want to change.",
			inputSchema: z.object({
				table: z.string().describe("Table name"),
				sys_id: z.string().describe("sys_id of the record to update"),
				fields: z.record(z.string(), z.string()).describe("Fields to change"),
			}),
		},
		async ({ table, sys_id, fields }) => {
			try {
				return json(await client.upsertRecord(table, fields, sys_id));
			} catch (err) {
				return toolError(err);
			}
		},
		),
	);

	tools.push(
		server.registerTool(
		"sn_get_table_schema",
		{
			title: "Get a ServiceNow table schema",
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			description:
				"Discover the live schema of a table: fields, types, max lengths, mandatory flags, and " +
				"reference targets. Reads sys_db_object and sys_dictionary on your instance. " +
				"Run this before creating or updating records to get exact field names.",
			inputSchema: z.object({
				table: z.string().describe("Table name to inspect"),
			}),
		},
		async ({ table }) => {
			try {
				return json(await client.discoverSchema(table));
			} catch (err) {
				return toolError(err);
			}
		},
		),
	);
	return tools;
}
