/**
 * Build the MCP server instance (name, version, tools).
 * Kept separate from transport/entrypoint concerns so it can be unit-tested.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { ServiceNowClient } from "./servicenow.js";
import { registerAllTools, type ToolRef } from "./tools.js";

export const SERVER_NAME = "servicenow-example-mcp";
export const SERVER_VERSION = "0.1.0";

export function createServer(client: ServiceNowClient): { server: McpServer; tools: ToolRef[] } {
	const server = new McpServer({
		name: SERVER_NAME,
		version: SERVER_VERSION,
	});

	server.registerResource(
		"about",
		`memo:///${SERVER_NAME}`,
		{
			title: "About this server",
			description: "What this server does and which ServiceNow credentials it uses.",
		},
		async () => ({
			contents: [
				{
					uri: `memo:///${SERVER_NAME}`,
					text:
						`${SERVER_NAME} v${SERVER_VERSION}\n\n` +
						"A Model Context Protocol server that gives AI agents read/write access to a " +
						"ServiceNow instance through the Table API (api/now/table).\n\n" +
						"Credentials come from the server environment: SN_INSTANCE, SN_USERNAME, " +
						"SN_PASSWORD (basic auth) or SN_TOKEN (OAuth bearer). The agent never sees them — " +
						"it talks to this server, and this server talks to ServiceNow.\n\n" +
						"Tools:\n" +
						"- Table API: sn_query_records, sn_get_record, sn_create_record, sn_update_record, sn_get_table_schema\n" +
						"- Scripts & update sets: sn_run_script, sn_get_current_update_set, sn_switch_update_set\n" +
						"- CI/CD: sn_run_atf_suite, sn_run_instance_scan\n\n" +
						"Recommended flow: discover schema -> query records -> act. Always check " +
						"field names against sn_get_table_schema before writing. Before making " +
						"changes, sn_switch_update_set into a dedicated update set so the work is " +
						"captured and reviewable; afterwards run sn_run_instance_scan over that " +
						"set and sn_run_atf_suite to prove nothing broke.",
				},
			],
		}),
	);

	const tools = registerAllTools(server, client);

	return { server, tools };
}
