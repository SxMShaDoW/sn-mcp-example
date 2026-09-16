/**
 * Minimal ServiceNow Table API client for Cloudflare Workers.
 * Auth: basic (username/password) or bearer token.
 *
 * `fetch` is injected so tests can stub it; defaults to globalThis.fetch.
 */

export interface ServiceNowConfig {
	instance: string;
	auth: { type: "basic"; username: string; password: string } | { type: "bearer"; token: string };
	fetchImpl?: typeof fetch;
}

export interface TableQueryParams {
	table: string;
	query?: string;
	fields?: string[];
	limit?: number;
	offset?: number;
	displayValue?: "true" | "false" | "all";
}

export interface SchemaField {
	name: string;
	label: string;
	type: string;
	maxLength: number;
	mandatory: boolean;
	reference?: string;
}

export interface TableSchema {
	table: string;
	label: string;
	extends: string;
	fields: SchemaField[];
}

export interface RunScriptResult {
	/** True when the platform deleted the one-shot trigger (script ran to completion). */
	completed: boolean;
	/** Output the script staged via `setScriptOutput()`. Empty when not set. */
	output: string;
	/** Set when output is empty — explains why (never ran, scratch write failed). */
	note?: string;
	/** Wall-clock seconds the trigger took to run and be reaped. */
	elapsedSeconds: number;
}

interface KeyValueLike {
	display_value?: string;
	value?: string;
	link?: string;
}

/** Hard cap on script output returned to the model (context-bloat guard). */
export const MAX_SCRIPT_OUTPUT = 4000;

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** Normalize ServiceNow's `"field": { "value": ..., "display_value": ... }` envelope. */
export function val(v: unknown): string {
	if (typeof v === "object" && v !== null && "value" in (v as KeyValueLike)) {
		const kv = v as KeyValueLike;
		return kv.display_value || String(kv.value ?? "");
	}
	return String(v ?? "");
}

export class ServiceNowClient {
	private config: ServiceNowConfig;
	private fetchImpl: typeof fetch;

	constructor(config: ServiceNowConfig) {
		this.config = config;
		this.fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);
	}

	private get baseUrl(): string {
		return this.config.instance.replace(/\/$/, "");
	}

	private get headers(): Record<string, string> {
		const h: Record<string, string> = {
			Accept: "application/json",
			"Content-Type": "application/json",
		};
		if (this.config.auth.type === "basic") {
			h["Authorization"] = `Basic ${btoa(`${this.config.auth.username}:${this.config.auth.password}`)}`;
		} else {
			h["Authorization"] = `Bearer ${this.config.auth.token}`;
		}
		return h;
	}

	async queryTable(params: TableQueryParams): Promise<unknown[]> {
		const url = new URL(`/api/now/table/${encodeURIComponent(params.table)}`, this.baseUrl);
		if (params.query) url.searchParams.set("sysparm_query", params.query);
		if (params.fields) url.searchParams.set("sysparm_fields", params.fields.join(","));
		if (params.limit) url.searchParams.set("sysparm_limit", String(params.limit));
		if (params.offset) url.searchParams.set("sysparm_offset", String(params.offset));
		if (params.displayValue) url.searchParams.set("sysparm_display_value", params.displayValue);

		const resp = await this.fetchImpl(url.toString(), { headers: this.headers });
		if (!resp.ok) {
			const body = await resp.text();
			throw new Error(`Table API error ${resp.status}: ${body.slice(0, 500)}`);
		}
		const data = (await resp.json()) as { result: unknown[] };
		return data.result;
	}

	/** Get a record; returns `null` on 404 (used by the sys_trigger poll loop). */
	async getRecord(table: string, sysId: string): Promise<unknown> {
		const url = new URL(
			`/api/now/table/${encodeURIComponent(table)}/${encodeURIComponent(sysId)}`,
			this.baseUrl,
		);
		const resp = await this.fetchImpl(url.toString(), { headers: this.headers });
		if (resp.status === 404) return null;
		if (!resp.ok) {
			const body = await resp.text();
			throw new Error(`Table API error ${resp.status}: ${body.slice(0, 500)}`);
		}
		const data = (await resp.json()) as { result: unknown };
		return data.result;
	}

	/**
	 * Raw authenticated request against a ServiceNow REST path (used by the
	 * CI/CD tools for /api/sn_cicd/*). Returns the parsed body verbatim.
	 */
	async apiGet<T>(path: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<T> {
		const url = new URL(path, this.baseUrl);
		const resp = await this.fetchImpl(url.toString(), {
			method,
			headers: this.headers,
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		});
		if (!resp.ok) {
			const text = await resp.text();
			throw new Error(`ServiceNow API error ${resp.status} (${path}): ${text.slice(0, 500)}`);
		}
		return (await resp.json()) as T;
	}

	/** Internal create used by runScript before the public create tool exists on all paths. */
	private async createRecordInternal(table: string, fields: Record<string, unknown>): Promise<unknown> {
		const url = new URL(`/api/now/table/${encodeURIComponent(table)}`, this.baseUrl);
		const resp = await this.fetchImpl(url.toString(), {
			method: "POST",
			headers: this.headers,
			body: JSON.stringify(fields),
		});
		if (!resp.ok) {
			const body = await resp.text();
			throw new Error(`Table API error ${resp.status}: ${body.slice(0, 500)}`);
		}
		const data = (await resp.json()) as { result: unknown };
		return data.result;
	}

	/**
	 * Create or update a record. Pass `sysId` to update an existing record;
	 * omit it to create a new one.
	 */
	async upsertRecord(
		table: string,
		fields: Record<string, string>,
		sysId?: string,
	): Promise<unknown> {
		const suffix = sysId ? `/${encodeURIComponent(sysId)}` : "";
		const url = new URL(`/api/now/table/${encodeURIComponent(table)}${suffix}`, this.baseUrl);
		const resp = await this.fetchImpl(url.toString(), {
			method: sysId ? "PATCH" : "POST",
			headers: this.headers,
			body: JSON.stringify(fields),
		});
		if (!resp.ok) {
			const body = await resp.text();
			throw new Error(`Table API error ${resp.status}: ${body.slice(0, 500)}`);
		}
		const data = (await resp.json()) as { result: unknown };
		return data.result;
	}

	/**
	 * Delete a record by sys_id (204 on success). Used for the script-runner
	 * scratch record so output capture leaves nothing behind.
	 */
	async deleteRecord(table: string, sysId: string): Promise<void> {
		const url = new URL(
			`/api/now/table/${encodeURIComponent(table)}/${encodeURIComponent(sysId)}`,
			this.baseUrl,
		);
		const resp = await this.fetchImpl(url.toString(), {
			method: "DELETE",
			headers: this.headers,
		});
		if (!resp.ok && resp.status !== 404) {
			const body = await resp.text();
			throw new Error(`Table API error ${resp.status}: ${body.slice(0, 500)}`);
		}
	}

	/**
	 * Run server-side JavaScript (full GlideRecord access) by creating a
	 * one-shot `sys_trigger` record and polling until ServiceNow removes it —
	 * the platform deletes a Run-Once trigger whether or not the script
	 * threw, so "deleted" means "ran", not "succeeded".
	 *
	 * Output channel (the sn-rust side-channel pattern, generalized): the
	 * runner first creates a scratch `release_task` (task-family data — not
	 * captured in update sets), whose `description` starts as a pending
	 * sentinel. The wrapper defines `setScriptOutput(text)` for the script
	 * (it is not a platform global), catches thrown errors into the output,
	 * and writes the result into the scratch record via GlideRecord — the
	 * same write-from-trigger primitive sn-rust's ATF step scripts use.
	 * After the trigger is deleted the runner reads the scratch record's
	 * description and deletes the record, leaving nothing behind.
	 */
	async runScript(script: string, options?: { scope?: string; timeoutSeconds?: number }): Promise<RunScriptResult> {
		const timeoutSeconds = options?.timeoutSeconds ?? 60;
		const started = Date.now();
		const marker = `mcp_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
		const scratchTable = "release_task";
		const PENDING = "__MCP_PENDING__";

		const scratch = (await this.createRecordInternal(scratchTable, {
			short_description: `mcp script output scratch ${marker}`,
			description: PENDING,
		})) as Record<string, unknown>;
		const scratchId = String(scratch.sys_id);

		const wrapper =
			"var __mcpOutput = '';\n" +
			"function setScriptOutput(s) { __mcpOutput = String(s); }\n" +
			"try {\n" +
			script +
			"\n} catch (e) { __mcpOutput = 'ERROR: ' + (e.message || e); }\n" +
			"try {\n" +
			"var __mcpScratch = new GlideRecord('release_task');\n" +
			`if (__mcpScratch.get('${scratchId}')) {\n` +
			"__mcpScratch.description = __mcpOutput.length > 3500 ? __mcpOutput.slice(0, 3500) + '\\n…[output truncated at 3500 chars]' : __mcpOutput;\n" +
			"__mcpScratch.update();\n" +
			"}\n" +
			"} catch (ignored) {}";
		const data: Record<string, unknown> = {
			name: marker,
			trigger_type: "0", // 0 = Run Once
			state: "0", // 0 = Ready
			script: wrapper,
		};
		if (options?.scope) data.sys_scope = options.scope;

		let triggerId = "";
		try {
			const trigger = (await this.createRecordInternal("sys_trigger", data)) as Record<string, unknown>;
			triggerId = String(trigger.sys_id);

			// Poll until the platform picks the trigger up and deletes it.
			const deadline = started + timeoutSeconds * 1000;
			let completed = false;
			while (Date.now() < deadline) {
				await sleep(1000);
				try {
					if ((await this.getRecord("sys_trigger", triggerId)) === null) {
						completed = true;
						break;
					}
				} catch {
					// Transient read errors count as "not done yet".
				}
			}

			// Read the result back from the scratch record's description.
			let output = "";
			let note = "";
			const after = (await this.getRecord(scratchTable, scratchId)) as Record<string, unknown> | null;
			const description = typeof after?.description === "string" ? after.description : "";
			if (description === PENDING) {
				note = completed
					? "trigger completed but did not write output (script may have failed to load, or the scratch write failed)"
					: "timed out before the trigger ran";
			} else {
				output = description;
			}
			return {
				completed,
				...(note ? { note } : {}),
				output: output.length > MAX_SCRIPT_OUTPUT
					? output.slice(0, MAX_SCRIPT_OUTPUT) +
						`\n…[truncated ${output.length - MAX_SCRIPT_OUTPUT} chars — script printed too much; filter inside the script instead]`
					: output,
				elapsedSeconds: Math.round(((Date.now() - started) / 1000) * 10) / 10,
			};
		} finally {
			// Self-cleaning: the scratch record never outlives the call.
			if (scratchId) {
				try {
					await this.deleteRecord(scratchTable, scratchId);
				} catch {
					// Non-fatal — report rather than fail the tool call.
				}
			}
		}
	}

	/**
	 * Get the currently active update set for the credential's user.
	 * Reads `sys_update_set` where `state=in progress` AND `sys_id` is in the
	 * user's `sys_update_set_list`... simplified: ServiceNow exposes the
	 * current set per-user via the `sys_update_set` rows with state
	 * "In progress"; the one the user is actually "in" is tracked on their
	 * user record preference `sys_update_set_list`. The robust check used here
	 * is the user preference.
	 */
	async getCurrentUpdateSet(): Promise<Record<string, unknown> | null> {
		const username = this.config.auth.type === "basic" ? this.config.auth.username : null;
		let userSysId: string | null = null;
		if (username) {
			const users = await this.queryTable({
				table: "sys_user",
				query: `user_name=${username}`,
				fields: ["sys_id"],
				limit: 1,
			});
			userSysId = (users[0] as Record<string, unknown> | undefined)?.sys_id as string | undefined ?? null;
		}

		// The per-user "current update set" pointer lives in sys_user_preference.
		if (userSysId) {
			const prefs = await this.queryTable({
				table: "sys_user_preference",
				query: `name=sys_update_set_list^user=${userSysId}`,
				fields: ["value"],
				limit: 1,
			});
			const prefValue = (prefs[0] as Record<string, unknown> | undefined)?.value as string | undefined;
			const currentId = prefValue?.split(",").map((s) => s.trim()).filter(Boolean)[0];
			if (currentId && currentId !== "") {
				const sets = await this.queryTable({
					table: "sys_update_set",
					query: `sys_id=${currentId}`,
					limit: 1,
				});
				const set = sets[0] as Record<string, unknown> | undefined;
				if (set) return set;
			}
		}

		// Fallback: the most recent in-progress set the user started.
		const sets = await this.queryTable({
			table: "sys_update_set",
			query: "state=in progress^ORDERBYDESCsys_updated_on",
			limit: 1,
		});
		return (sets[0] as Record<string, unknown> | undefined) ?? null;
	}

	/**
	 * Switch a named user's current update set (the `userSysId` is resolved
	 * by the caller — triggers run as `system`, so `gs.getUser()` inside the
	 * script is the wrong identity; sn-rust solves the same problem with its
	 * impersonation hook, we just pass the id explicitly).
	 *
	 * There is no public Table API write to the per-user pointer (the
	 * preference row is written by the UI's `UpdateSetAjax` processor), so
	 * this runs a GlideRecord script as a one-shot sys_trigger — the same
	 * mechanism as `runScript`. The script points the user's
	 * `sys_update_set_list` preference at the chosen set's sys_id.
	 */
	async switchUpdateSet(updateSetSysId: string, timeoutSeconds = 45): Promise<RunScriptResult> {
		// Validate before writing anything: a bad sys_id must fail cleanly,
		// not silently rewrite a user's preference pointer.
		const sets = await this.queryTable({
			table: "sys_update_set",
			query: `sys_id=${updateSetSysId}`,
			fields: ["name", "state"],
			limit: 1,
		});
		const target = sets[0] as Record<string, unknown> | undefined;
		if (!target) {
			throw new Error(
				`Update set ${updateSetSysId} not found on this instance — query sys_update_set for valid sys_ids`,
			);
		}

		// Resolve the credential user so the preference write lands on the
		// right user even though the trigger executes as `system`.
		let userSysId = "";
		if (this.config.auth.type === "basic") {
			const users = await this.queryTable({
				table: "sys_user",
				query: `user_name=${this.config.auth.username}`,
				fields: ["sys_id"],
				limit: 1,
			});
			userSysId = String((users[0] as Record<string, unknown> | undefined)?.sys_id ?? "");
		}
		if (!userSysId) {
			throw new Error(
				"Cannot resolve the credential user's sys_id from the configured username — update-set switching needs basic auth",
			);
		}

		const script = `var prefOwner = '${userSysId}';
var prefName = 'sys_update_set_list';
var grPref = new GlideRecord('sys_user_preference');
grPref.addQuery('user', prefOwner);
grPref.addQuery('name', prefName);
grPref.query();
var value = '${updateSetSysId}';
if (grPref.next()) {
  grPref.value = value;
  grPref.update();
} else {
  grPref.initialize();
  grPref.user = prefOwner;
  grPref.name = prefName;
  grPref.value = value;
  grPref.insert();
}
var grSet = new GlideRecord('sys_update_set');
var label = 'unknown';
if (grSet.get('${updateSetSysId}')) {
  label = grSet.getValue('name') + ' (' + grSet.getValue('sys_id') + ')';
}
setScriptOutput('Switched update set to: ' + label);`;
		return this.runScript(script, { timeoutSeconds });
	}

	async discoverSchema(table: string): Promise<TableSchema> {
		const tableResult = await this.queryTable({
			table: "sys_db_object",
			query: `name=${table}`,
			fields: ["name", "label", "super_class.name"],
			limit: 1,
		});

		const tableInfo = (tableResult[0] || {}) as Record<string, unknown>;

		const fieldResult = await this.queryTable({
			table: "sys_dictionary",
			query: `name=${table}^internal_type!=collection`,
			fields: ["element", "column_label", "internal_type", "max_length", "mandatory", "reference"],
			limit: 500,
		});

		const fields: SchemaField[] = ((fieldResult as Array<Record<string, unknown>>) || [])
			.filter((f) => val(f.element))
			.map((f) => ({
				name: val(f.element),
				label: val(f.column_label) || val(f.element),
				type: val(f.internal_type) || "string",
				maxLength: Number.parseInt(val(f.max_length) || "0", 10),
				mandatory: val(f.mandatory) === "true",
				...(val(f.reference) ? { reference: val(f.reference) } : {}),
			}));

		return {
			table,
			label: val(tableInfo.label) || table,
			extends: val(tableInfo["super_class.name"]) || "",
			fields,
		};
	}
}
