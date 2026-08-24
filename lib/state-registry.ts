import type { Business } from "./maps";
import { classifyRole, scoreCompanyMatch, searchConnecticutRegistry, searchNycDoingBusiness, type SourceDebug, type SourcePerson } from "./owner-sources.ts";

export type RegistryStatus = "matched" | "no_match" | "ambiguous" | "blocked" | "timeout" | "http_error" | "parse_error" | "skipped";
export type RegistrySourceDebug = SourceDebug & { state: string; registryStatus: RegistryStatus; lookupQuery: string; recordsReturned: number; executionTimeMs: number };
export type StateRegistryAdapter = {
  state: string;
  sourceName: string;
  supports(company: Business): boolean;
  searchCompany(company: Business): Promise<SourceDebug>;
  getPeople(result: SourceDebug): SourcePerson[];
};

export function detectState(company: Business) {
  const value = company.address || "";
  const names: Record<string, string> = { Connecticut: "CT", "New York": "NY", Texas: "TX", California: "CA", Florida: "FL", "New Jersey": "NJ", Pennsylvania: "PA", Ohio: "OH", Illinois: "IL", Georgia: "GA", "North Carolina": "NC", Arizona: "AZ", Colorado: "CO", Washington: "WA", Massachusetts: "MA" };
  for (const [name, code] of Object.entries(names)) if (new RegExp(`\\b(?:${code}|${name})\\b`, "i").test(value)) return code;
  return "";
}

const skipped = (sourceName: string, state: string, business: Business): SourceDebug => ({ sourceName, attempted: false, input: `${business.name || ""} | ${business.address || ""} | ${business.phone || ""}`, status: "skipped", reason: `Skipped: adapter supports ${state} only.`, companyMatches: [], rejectedMatches: [], people: [] });
const mapStatus = (status: SourceDebug["status"]): RegistryStatus => status === "empty" ? "no_match" : status === "error" ? "http_error" : status;
const timed = async (adapter: StateRegistryAdapter, business: Business): Promise<RegistrySourceDebug> => {
  const start = performance.now();
  try {
    const result = adapter.supports(business) ? await adapter.searchCompany(business) : skipped(adapter.sourceName, adapter.state, business);
    const registryStatus = /ambiguous/i.test(result.reason || "") ? "ambiguous" : mapStatus(result.status);
    return { ...result, state: adapter.state, registryStatus, lookupQuery: result.input, recordsReturned: result.companyMatches.length + result.rejectedMatches.length, executionTimeMs: Math.round(performance.now() - start) };
  } catch (error) {
    const result: SourceDebug = { sourceName: adapter.sourceName, attempted: true, input: `${business.name || ""} | ${business.address || ""}`, status: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "error", reason: error instanceof Error ? error.message : "adapter failed", companyMatches: [], rejectedMatches: [], people: [] };
    return { ...result, state: adapter.state, registryStatus: mapStatus(result.status), lookupQuery: result.input, recordsReturned: 0, executionTimeMs: Math.round(performance.now() - start) };
  }
};

async function fetchRows(url: string) {
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(6000), headers: { "user-agent": "MapsOwnerFinder/0.1 state-registry-research" } });
    if (response.status === 403 || response.status === 429) return { status: "blocked" as const, reason: `HTTP ${response.status}`, rows: [] as Record<string, string>[] };
    if (!response.ok) return { status: "error" as const, reason: `HTTP ${response.status}`, rows: [] as Record<string, string>[] };
    return { status: "ok" as const, rows: await response.json() as Record<string, string>[] };
  } catch (error) {
    const timeout = error instanceof Error && error.name === "TimeoutError";
    return { status: timeout ? "timeout" as const : "error" as const, reason: error instanceof Error ? error.message : "request failed", rows: [] as Record<string, string>[] };
  }
}

export async function searchNewYorkStateRegistry(business: Business): Promise<SourceDebug> {
  const debug: SourceDebug = { sourceName: "New York Department of State — Active Corporations", attempted: true, input: `${business.name || ""} | ${business.address || ""}`, status: "empty", companyMatches: [], rejectedMatches: [], people: [] };
  if (!business.name) { debug.status = "skipped"; debug.attempted = false; debug.reason = "Company name is missing."; return debug; }
  const exact = business.name.toUpperCase().replace(/"/g, '""');
  const makeUrl = (where: string) => `https://data.ny.gov/resource/n9v6-gdp6.json?${new URLSearchParams({ "$where": where, "$limit": "25" })}`;
  let sourceUrl = makeUrl(`upper(current_entity_name) = "${exact}"`);
  let response = await fetchRows(sourceUrl);
  if (response.status !== "ok") { debug.status = response.status; debug.reason = response.reason; return debug; }
  if (!response.rows.length) {
    const tokens = business.name.toUpperCase().replace(/[^A-Z0-9]+/g, " ").split(" ").filter((token) => token.length > 1 && !["LLC", "INC", "CORP", "CORPORATION", "CO", "LTD"].includes(token));
    sourceUrl = makeUrl(`upper(current_entity_name) like '%${tokens.map((token) => token.replace(/'/g, "''")).join("%")}%'`);
    response = await fetchRows(sourceUrl);
    if (response.status !== "ok") { debug.status = response.status; debug.reason = response.reason; return debug; }
  }
  for (const row of response.rows) {
    const address = row.location_address_1 || row.dos_process_address_1 || row.chairman_address_1;
    const city = row.location_city || row.dos_process_city || row.chairman_city;
    const state = row.location_state || row.dos_process_state || row.chairman_state;
    const zip = row.location_zip || row.dos_process_zip || row.chairman_zip;
    const match = scoreCompanyMatch(business, { name: row.current_entity_name || "", address, city, state, zip });
    const recordUrl = `https://data.ny.gov/resource/n9v6-gdp6.json?dos_id=${encodeURIComponent(row.dos_id || "")}`;
    if (!match.accepted) { debug.rejectedMatches.push({ companyName: row.current_entity_name || "", sourceUrl: recordUrl, score: match.score, reason: `${match.reason}: ${match.evidence}` }); continue; }
    debug.companyMatches.push({ companyName: row.current_entity_name || "", sourceUrl: recordUrl, score: match.score, evidence: match.evidence });
    if (row.chairman_name) debug.people.push({ name: row.chairman_name, role: "CEO", relationshipType: classifyRole("CEO"), sourceName: debug.sourceName, sourceUrl: recordUrl, evidenceText: `${row.chairman_name} — CEO for ${row.current_entity_name}; New York DOS ID ${row.dos_id}.`, companyMatchEvidence: match.evidence, identityConfidence: Math.min(96, 70 + Math.round(match.score * 0.2)) });
  }
  if (debug.companyMatches.length > 1) debug.people = [];
  debug.status = debug.companyMatches.length === 1 ? "matched" : "empty";
  debug.reason = debug.companyMatches.length > 1 ? "Multiple company records passed matching; treated as ambiguous; people were not promoted to owner candidates." : debug.companyMatches.length ? undefined : "No New York corporation passed company/location matching.";
  return debug;
}

const adapters: StateRegistryAdapter[] = [
  { state: "CT", sourceName: "Connecticut Secretary of State", supports: (business) => detectState(business) === "CT", searchCompany: searchConnecticutRegistry, getPeople: (result) => result.people },
  { state: "NY", sourceName: "NYC Doing Business", supports: (business) => detectState(business) === "NY", searchCompany: searchNycDoingBusiness, getPeople: (result) => result.people },
  { state: "NY", sourceName: "New York Department of State — Active Corporations", supports: (business) => detectState(business) === "NY", searchCompany: searchNewYorkStateRegistry, getPeople: (result) => result.people },
];

export function getStateRegistryAdapters() { return adapters; }
export async function runStateRegistryAdapters(selected: StateRegistryAdapter[], business: Business) { return Promise.all(selected.map((adapter) => timed(adapter, business))); }
export async function searchStateRegistries(business: Business) { return runStateRegistryAdapters(adapters, business); }
