/**
 * CI/CD tools — "fire via CI/CD, check via Table API":
 *
 * Triggering has only one official path (/api/sn_cicd/*), but *checking* is
 * plain data: ATF results live in sys_atf_test_suite_result (rollups) and
 * sys_atf_test_result (per-test rows), and scan findings live in
 * scan_finding. Reading them through the Table API is ground truth — the
 * CI/CD progress endpoint can hang on runs the platform already finished
 * (observed live: a "skipped" suite run never reported terminal status).
 *
 * Endpoints used:
 * - POST /api/sn_cicd/testsuite/run?test_suite_sys_id={id}            → trigger ATF suite
 * - POST /api/sn_cicd/instance_scan/suite_scan/{suite_id}/update_sets → trigger scan
 * - GET  /api/sn_cicd/progress/{progress_id}                          → scan poll (no table status exists)
 * - GET  /api/sn_cicd/instance_scan/result/{progress_id}              → authoritative violation total
 *
 * ATF results come from sys_atf_test_suite_result (correlated by
 * test_suite + sys_created_on >= firedAt — links.results is racy at trigger
 * time) and sys_atf_test_result (parent = suite result).
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ServiceNowClient } from "./servicenow.js";
import type { ToolRef } from "./tools.js";
import { json, toolError } from "./tools.js";

interface CicdTrigger {
	result: {
		status: string;
		status_label: string;
		links: { progress: { id: string }; results?: { id: string } };
	};
}

interface CicdProgress {
	result: {
		status: string;
		status_label: string;
		message?: string;
		progress?: number;
		links: { progress: { id: string }; results?: { id: string } };
	};
}

interface ScanResultSummary {
	result: {
		status: string;
		status_label: string;
		total_violations?: string;
	};
}

const TERMINAL_STATUSES = new Set(["complete", "success", "failure", "error", "canceled"]);

/** sys_atf_test_suite_result statuses that mean "still going". */
const ATF_NON_TERMINAL = new Set(["pending", "running", "requested", "waiting"]);

/** ServiceNow datetime format (UTC — sys_created_on is stored UTC). */
function snTimeString(date: Date): string {
	return date.toISOString().slice(0, 19).replace("T", " ");
}

type Row = Record<string, unknown>;

export function registerCicdTools(server: McpServer, client: ServiceNowClient): ToolRef[] {
	const tools: ToolRef[] = [];
	tools.push(
		server.registerTool(
			"sn_run_atf_suite",
		{
			title: "Run an ATF test suite",
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: false,
			},
			description:
				"Trigger an Automated Test Framework (ATF) test suite by sys_id through ServiceNow's " +
				"CI/CD API, then check the result via the Table API (sys_atf_test_suite_result + " +
				"sys_atf_test_result) until it reaches a terminal status: success, failure, error, " +
				"skipped, or canceled. Returns pass/fail/error/skip rollups plus the first 10 test " +
				"results. Find suite sys_ids by querying sys_atf_test_suite. ATF must be enabled on " +
				"the instance and the credential needs atf_test_admin or admin.",
			inputSchema: z.object({
				suite_sys_id: z.string().describe("sys_id of the sys_atf_test_suite to run"),
				timeout_seconds: z.number().int().min(30).max(1800).default(600),
			}),
		},
		async ({ suite_sys_id, timeout_seconds }) => {
			try {
				return json(await runAtfSuite(client, suite_sys_id, timeout_seconds));
			} catch (err) {
				return toolError(err);
			}
		},
	));

	tools.push(
		server.registerTool(
			"sn_run_instance_scan",
		{
			title: "Run an instance scan over update sets",
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: false,
			},
			description:
				"Run an Instance Scan check suite (code quality) over one or more update sets by sys_id " +
				"through ServiceNow's CI/CD API, poll to completion, and read the findings via the " +
				"Table API (scan_finding). Use it as a post-build gate: after the agent writes changes " +
				"into an update set, scan that set for violations before shipping. Find suite sys_ids " +
				"by querying scan_check_suite.",
			inputSchema: z.object({
				suite_sys_id: z.string().describe("sys_id of the scan_check_suite to run"),
				update_set_sys_ids: z
					.array(z.string())
					.min(1)
					.describe("sys_ids of the update sets to scan (typically just-captured agent work)"),
				timeout_seconds: z.number().int().min(30).max(1800).default(600),
			}),
		},
		async ({ suite_sys_id, update_set_sys_ids, timeout_seconds }) => {
			try {
				return json(await runInstanceScan(client, suite_sys_id, update_set_sys_ids, timeout_seconds));
			} catch (err) {
				return toolError(err);
			}
		},
	));
	return tools;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function pollProgress(
	client: ServiceNowClient,
	progressId: string,
	timeoutSeconds: number,
): Promise<CicdProgress["result"] | null> {
	const deadline = Date.now() + timeoutSeconds * 1000;
	while (Date.now() < deadline) {
		await sleep(3000);
		try {
			const resp = await client.apiGet<CicdProgress>(`/api/sn_cicd/progress/${progressId}`);
			if (TERMINAL_STATUSES.has(String(resp.result.status).toLowerCase())) {
				return resp.result;
			}
		} catch {
			// Transient read errors count as "not done yet".
		}
	}
	return null;
}

/**
 * Fire via CI/CD, check via Table API. The suite result row is correlated by
 * test_suite + sys_created_on >= firedAt (15s clock-skew allowance) — the
 * trigger response's links.results is racy and sometimes absent.
 */
async function runAtfSuite(client: ServiceNowClient, suiteSysId: string, timeoutSeconds: number) {
	const firedAt = new Date(Date.now() - 15_000);
	const trigger = await client.apiGet<CicdTrigger>(
		`/api/sn_cicd/testsuite/run?test_suite_sys_id=${encodeURIComponent(suiteSysId)}`,
		"POST",
	);
	const progressId = trigger.result.links.progress.id;

	const deadline = Date.now() + timeoutSeconds * 1000;
	let row: Row | undefined;
	let sawRow = false;
	while (Date.now() < deadline) {
		await sleep(3000);
		try {
			const rows = await client.queryTable({
				table: "sys_atf_test_suite_result",
				query:
					`test_suite=${suiteSysId}^sys_created_on>=${snTimeString(firedAt)}` +
					`^ORDERBYDESCsys_created_on`,
				fields: [
					"sys_id",
					"status",
					"run_time",
					"rolled_up_test_success_count",
					"rolled_up_test_failure_count",
					"rolled_up_test_error_count",
					"rolled_up_test_skip_count",
				],
				limit: 1,
			});
			row = rows[0] as Row | undefined;
			if (row) {
				sawRow = true;
				const status = String(row.status ?? "").toLowerCase();
				if (!ATF_NON_TERMINAL.has(status)) break;
			}
		} catch {
			// Transient read errors count as "not done yet".
		}
	}

	if (!row || ATF_NON_TERMINAL.has(String(row.status ?? "").toLowerCase())) {
		return {
			timedOut: true,
			suiteSysId,
			progressId,
			hint:
				`No terminal suite result within ${timeoutSeconds}s. Check ground truth with ` +
				`sn_query_records on sys_atf_test_suite_result (test_suite=${suiteSysId}, newest row) — ` +
				`the run may have finished (or been skipped) without the CI/CD progress reporting it.`,
		};
	}

	// Per-test detail (best-effort).
	let tests: unknown[] = [];
	try {
		tests = await client.queryTable({
			table: "sys_atf_test_result",
			query: `parent=${row.sys_id}^ORDERBYDESCsys_created_on`,
			fields: ["test_name", "status", "run_time"],
			limit: 10,
		});
	} catch {
		// Non-fatal — rollups are the headline.
	}

	return {
		suiteSysId,
		suiteResultId: row.sys_id,
		progressId,
		status: row.status,
		duration: row.run_time,
		passed: Number(row.rolled_up_test_success_count ?? 0),
		failed: Number(row.rolled_up_test_failure_count ?? 0),
		errors: Number(row.rolled_up_test_error_count ?? 0),
		skipped: Number(row.rolled_up_test_skip_count ?? 0),
		tests,
	};
}

/**
 * Fire via CI/CD, poll progress (scan tables carry no status field), then
 * read the actual findings via the Table API: scan_result.progress_id →
 * scan_finding.result.
 */
async function runInstanceScan(
	client: ServiceNowClient,
	suiteSysId: string,
	updateSetSysIds: string[],
	timeoutSeconds: number,
) {
	const trigger = await client.apiGet<CicdTrigger>(
		`/api/sn_cicd/instance_scan/suite_scan/${encodeURIComponent(suiteSysId)}/update_sets`,
		"POST",
		{ update_set_sys_ids: updateSetSysIds },
	);
	const progressId = trigger.result.links.progress.id;
	const progress = await pollProgress(client, progressId, timeoutSeconds);
	if (!progress) {
		return {
			timedOut: true,
			suiteSysId,
			updateSetSysIds,
			progressId,
			hint:
				`Still scanning after ${timeoutSeconds}s. Check with sn_query_records on scan_finding ` +
				`(join: scan_result where progress_id=${progressId} → scan_finding.result = its sys_id).`,
		};
	}

	// Findings via Table API (unmuted only — muted rows don't count).
	let findings: unknown[] = [];
	let findingsNote = "no scan_result record found for this progress id";
	try {
		const scanRows = await client.queryTable({
			table: "scan_result",
			query: `progress_id=${progressId}`,
			fields: ["sys_id"],
			limit: 1,
		});
		const scanResultId = String((scanRows[0] as Row | undefined)?.sys_id ?? "");
		if (scanResultId) {
			findings = await client.queryTable({
				table: "scan_finding",
				query: `result=${scanResultId}^muted=false^ORDERBYsys_created_on`,
				fields: ["source", "check", "finding_details", "muted"],
				limit: 10,
			});
			findingsNote = "first 10 unmuted findings";
		}
	} catch {
		// Non-fatal — the violation total from the run summary is the headline.
	}

	// Authoritative violation total (no table column carries it).
	let totalViolations = 0;
	try {
		const summary = await client.apiGet<ScanResultSummary>(
			`/api/sn_cicd/instance_scan/result/${progressId}`,
		);
		totalViolations = Number(summary.result.total_violations ?? 0);
	} catch {
		// Non-fatal — findings above still tell the agent what to fix.
	}

	return {
		finalStatus: progress.status_label,
		totalViolations,
		findings,
		findingsNote,
		progressId,
	};
}
