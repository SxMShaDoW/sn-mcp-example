/**
 * Server-side script execution tools.
 *
 * `sn_run_script` is the escape hatch: arbitrary server-side JavaScript with
 * full GlideRecord access, executed via a one-shot `sys_trigger` record — no
 * Scripted REST endpoint needs to exist on the instance.
 *
 * `sn_get_current_update_set` / `sn_switch_update_set` build on it: capture
 * work into a named update set, switch the credential user's active set, and
 * read back where changes are landing. This is the CI/CD-friendly way to make
 * an agent's changes reviewable and reversible.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ServiceNowClient } from "./servicenow.js";
import type { ToolRef } from "./tools.js";
import { json, toolError } from "./tools.js";

export function registerScriptTools(server: McpServer, client: ServiceNowClient): ToolRef[] {
	const tools: ToolRef[] = [];

	tools.push(
		server.registerTool(
		"sn_run_script",
		{
			title: "Run server-side script",
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: true,
			},
			description:
				"Execute arbitrary server-side JavaScript (GlideRecord, GlideSystem, gs.*) on the " +
				"ServiceNow instance. Runs as a one-shot Scheduled Script (sys_trigger, Run Once); " +
				"the platform deletes the trigger when the script finishes, so completion is " +
				"detected by disappearance. Return output by calling setScriptOutput('...') — " +
				"the wrapper catches thrown errors and reports them as 'ERROR: ...'. " +
				"Requires the credential to be able to create sys_trigger records (admin or " +
				"a role with scheduler access).",
			inputSchema: z.object({
				script: z.string().describe(
					"JavaScript to run server-side. Example: \"var gr = new GlideRecord('incident'); " +
						"gr.addQuery('active','true'); gr.query(); setScriptOutput('open: ' + gr.getRowCount());\"",
				),
				scope: z.string().optional().describe("Application scope to run in (default: global)"),
				timeout_seconds: z.number().int().min(5).max(300).default(60),
			}),
		},
		async ({ script, scope, timeout_seconds }) => {
			try {
				return json(await client.runScript(script, { scope, timeoutSeconds: timeout_seconds }));
			} catch (err) {
				return toolError(err);
			}
		},
		),
	);

	tools.push(
		server.registerTool(
		"sn_get_current_update_set",
		{
			title: "Get current update set",
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			description:
				"Show which update set the credential's user is currently capturing changes into, " +
				"plus the most recent in-progress update sets on the instance.",
			inputSchema: z.object({}),
		},
		async () => {
			try {
				const current = await client.getCurrentUpdateSet();
				const recent = await client.queryTable({
					table: "sys_update_set",
					query: "state=in progress^ORDERBYDESCsys_updated_on",
					fields: ["name", "sys_id", "state", "sys_updated_on"],
					limit: 5,
				});
				return json({ current, recentInProgress: recent });
			} catch (err) {
				return toolError(err);
			}
		},
		),
	);

	tools.push(
		server.registerTool(
		"sn_switch_update_set",
		{
			title: "Switch update set",
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			description:
				"Switch the credential user's active update set by sys_id (run sn_get_current_update_set " +
				"first to find ids, or query sys_update_set). Validates that the set exists before " +
				"switching. Implemented as a GlideRecord script that " +
				"points the user's 'sys_update_set_list' preference at the chosen set — the same thing " +
				"the update-set picker UI does. Changes made after this land in the chosen set, which " +
				"makes agent-driven changes reviewable and transportable.",
			inputSchema: z.object({
				update_set_sys_id: z
					.string()
					.min(32)
					.describe("sys_id of the sys_update_set to switch into"),
			}),
		},
		async ({ update_set_sys_id }) => {
			try {
				const result = await client.switchUpdateSet(update_set_sys_id);
				return json({
					...result,
					hint: result.completed
						? "Verify with sn_get_current_update_set."
						: "Trigger did not complete within the timeout — check the instance's scheduler.",
				});
			} catch (err) {
				return toolError(err);
			}
		},
		),
	);
	return tools;
}
