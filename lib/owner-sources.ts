import type { Business } from "./maps";

export type RelationshipType = "owner_relationship" | "decision_maker" | "registered_agent" | "unknown";
export type SourcePerson = {
  name: string;
  role: string;
  relationshipType: RelationshipType;
  sourceName: string;
  sourceUrl: string;
  evidenceText: string;
  companyMatchEvidence: string;
  identityConfidence: number;
};
export type SourceMatch = { companyName: string; sourceUrl: string; score: number; evidence: string };
export type SourceReject = { companyName: string; sourceUrl?: string; score: number; reason: string };
export type SourceDebug = {
  sourceName: string;
  attempted: boolean;
  input: string;
  status: "matched" | "empty" | "skipped" | "blocked" | "timeout" | "error";
  reason?: string;
  companyMatches: SourceMatch[];
  rejectedMatches: SourceReject[];
  people: SourcePerson[];
};

function normalize(value?: string) { return (value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\bl l c\b/g, "llc").replace(/\bi n c\b/g, "inc").replace(/\bc o r p\b/g, "corp").trim(); }
function tokens(value?: string) { return normalize(value).split(" ").filter((token) => token.length > 1 && !new Set(["the", "and", "of", "inc", "llc", "ltd", "corp", "corporation", "company", "co"]).has(token)); }
function phoneDigits(value?: string) { const digits = (value || "").replace(/\D/g, ""); return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits; }
function stateFromBusiness(business: Business) {
  const text = `${business.address || ""} ${business.name || ""}`;
  if (/\b(?:CT|Connecticut)\b/i.test(text)) return "CT";
  if (/\b(?:NY|New York)\b/i.test(text)) return "NY";
  return "";
}
function zipFromAddress(address?: string) { return address?.match(/\b\d{5}(?:-\d{4})?\b/)?.[0] || ""; }

export function classifyRole(role: string): RelationshipType {
  if (/registered agent/i.test(role)) return "registered_agent";
  if (/\b(owner|founder|co-founder|proprietor|member|managing member|partner)\b/i.test(role)) return "owner_relationship";
  if (/\b(president|ceo|chief executive|coo|chief operating|cfo|chief financial|manager|principal|officer|director)\b/i.test(role)) return "decision_maker";
  return "unknown";
}

export function scoreCompanyMatch(input: Business, record: { name: string; address?: string; city?: string; state?: string; zip?: string; phone?: string }) {
  const inputName = normalize(input.name); const recordName = normalize(record.name);
  const inputTokens = tokens(input.name); const recordTokens = new Set(tokens(record.name));
  const matchedTokens = inputTokens.filter((token) => recordTokens.has(token)).length;
  const nameRatio = inputTokens.length ? matchedTokens / inputTokens.length : 0;
  let score = inputName && inputName === recordName ? 60 : Math.round(nameRatio * 45);
  const evidence: string[] = [inputName === recordName ? "exact normalized name" : `${matchedTokens}/${inputTokens.length} name tokens`];
  const inputAddress = normalize(input.address); const street = normalize(record.address);
  if (street && inputAddress.includes(street)) { score += 15; evidence.push("street match"); }
  if (record.city && inputAddress.includes(normalize(record.city))) { score += 10; evidence.push("city match"); }
  if (record.state && stateFromBusiness(input) === record.state.toUpperCase()) { score += 8; evidence.push("state match"); }
  const inputZip = zipFromAddress(input.address); if (record.zip && inputZip && inputZip === record.zip.slice(0, 5)) { score += 12; evidence.push("ZIP match"); }
  if (record.phone && input.phone && phoneDigits(record.phone) === phoneDigits(input.phone)) { score += 18; evidence.push("business phone match"); }
  const accepted = (inputName === recordName && score >= 68) || (nameRatio >= 0.8 && score >= 63);
  return { accepted, score, evidence: evidence.join(", "), reason: accepted ? "company signals are sufficient" : "insufficient combined company/location signals" };
}

async function fetchJson(url: string) {
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(6000), headers: { "user-agent": "MapsOwnerFinder/0.1 public-record-research" } });
    if (response.status === 403 || response.status === 429) return { status: "blocked" as const, reason: `HTTP ${response.status}`, rows: [] as Record<string, string>[] };
    if (!response.ok) return { status: "error" as const, reason: `HTTP ${response.status}`, rows: [] as Record<string, string>[] };
    return { status: "ok" as const, rows: await response.json() as Record<string, string>[] };
  } catch (error) {
    const timeout = error instanceof Error && error.name === "TimeoutError";
    return { status: timeout ? "timeout" as const : "error" as const, reason: error instanceof Error ? error.message : "request failed", rows: [] as Record<string, string>[] };
  }
}
function socrataUrl(domain: string, dataset: string, params: Record<string, string>) {
  const query = new URLSearchParams(params); return `https://${domain}/resource/${dataset}.json?${query}`;
}

export async function searchConnecticutRegistry(business: Business): Promise<SourceDebug> {
  const input = `${business.name || ""} | ${business.address || ""} | ${business.phone || ""}`;
  const debug: SourceDebug = { sourceName: "Connecticut Secretary of State", attempted: false, input, status: "skipped", companyMatches: [], rejectedMatches: [], people: [] };
  if (stateFromBusiness(business) !== "CT") { debug.reason = "Skipped: no Connecticut state signal in input."; return debug; }
  if (!business.name) { debug.reason = "Skipped: company name is missing."; return debug; }
  debug.attempted = true;
  const exactName = business.name.toUpperCase().replace(/"/g, '""');
  const masterUrl = socrataUrl("data.ct.gov", "n7gp-d28j", { "$where": `upper(name) = "${exactName}"`, "$limit": "20" });
  let master = await fetchJson(masterUrl);
  if (master.status !== "ok") { debug.status = master.status; debug.reason = master.reason; return debug; }
  if (!master.rows.length) {
    const namePattern = tokens(business.name).map((token) => token.toUpperCase().replace(/'/g, "''")).join("%");
    if (namePattern) {
      const flexibleUrl = socrataUrl("data.ct.gov", "n7gp-d28j", { "$where": `upper(name) like '%${namePattern}%'`, "$limit": "20" });
      master = await fetchJson(flexibleUrl);
      if (master.status !== "ok") { debug.status = master.status; debug.reason = master.reason; return debug; }
    }
  }
  for (const row of master.rows) {
    const sourceUrl = `https://data.ct.gov/resource/n7gp-d28j.json?id=${encodeURIComponent(row.id || "")}`;
    const match = scoreCompanyMatch(business, { name: row.name || "", address: row.billingstreet, city: row.billingcity, state: row.billingstate, zip: row.billingpostalcode });
    if (!match.accepted) { debug.rejectedMatches.push({ companyName: row.name || "", sourceUrl, score: match.score, reason: `${match.reason}: ${match.evidence}` }); continue; }
    debug.companyMatches.push({ companyName: row.name || "", sourceUrl, score: match.score, evidence: match.evidence });
    const principalUrl = socrataUrl("data.ct.gov", "ka36-64k6", { "$where": `business_id='${(row.id || "").replace(/'/g, "''")}'`, "$limit": "50" });
    const principals = await fetchJson(principalUrl);
    if (principals.status !== "ok") { debug.reason = `Company matched, but principals lookup failed: ${principals.reason}`; continue; }
    for (const person of principals.rows) {
      const role = person.designation || person.type || "Principal"; const relationshipType = classifyRole(role);
      if (relationshipType === "registered_agent" || relationshipType === "unknown") continue;
      const name = person.name__c || [person.firstname, person.middlename, person.lastname, person.suffix].filter(Boolean).join(" ");
      if (!name) continue;
      debug.people.push({ name, role, relationshipType, sourceName: debug.sourceName, sourceUrl: principalUrl, evidenceText: `${name} — ${role}; linked by Connecticut business ID ${row.id} to ${row.name}.`, companyMatchEvidence: match.evidence, identityConfidence: Math.min(98, 72 + Math.round(match.score * 0.2)) });
    }
  }
  debug.status = debug.companyMatches.length ? "matched" : "empty";
  debug.reason ||= debug.companyMatches.length ? undefined : "No company record passed name and location matching.";
  return debug;
}

const nycRoles: Record<string, string> = { OWN: "Owner", CEO: "CEO", COO: "COO", CFO: "CFO", MGR: "Manager" };
export async function searchNycDoingBusiness(business: Business): Promise<SourceDebug> {
  const input = `${business.name || ""} | ${business.address || ""} | ${business.phone || ""}`;
  const debug: SourceDebug = { sourceName: "NYC Doing Business", attempted: false, input, status: "skipped", companyMatches: [], rejectedMatches: [], people: [] };
  const address = normalize(business.address);
  if (stateFromBusiness(business) !== "NY" && !address.includes("new york")) { debug.reason = "Skipped: no New York state/city signal in input."; return debug; }
  if (!business.name) { debug.reason = "Skipped: company name is missing."; return debug; }
  debug.attempted = true;
  const entityUrl = socrataUrl("data.cityofnewyork.us", "72mk-a8z7", { "$q": business.name, "$limit": "20" });
  const entities = await fetchJson(entityUrl);
  if (entities.status !== "ok") { debug.status = entities.status; debug.reason = entities.reason; return debug; }
  const acceptedNames = new Set<string>();
  for (const row of entities.rows) {
    const match = scoreCompanyMatch(business, { name: row.organization_name || "", state: "NY", phone: row.organization_phone });
    if (match.accepted) { acceptedNames.add(normalize(row.organization_name)); debug.companyMatches.push({ companyName: row.organization_name, sourceUrl: entityUrl, score: match.score, evidence: match.evidence }); }
    else debug.rejectedMatches.push({ companyName: row.organization_name || "", sourceUrl: entityUrl, score: match.score, reason: `${match.reason}: ${match.evidence}` });
  }
  if (acceptedNames.size) {
    const peopleUrl = socrataUrl("data.cityofnewyork.us", "2sps-j9st", { "$q": business.name, "$limit": "100" });
    const people = await fetchJson(peopleUrl);
    if (people.status !== "ok") { debug.status = people.status; debug.reason = `Company matched, but people lookup failed: ${people.reason}`; return debug; }
    for (const row of people.rows) {
      if (!acceptedNames.has(normalize(row.organization_name))) continue;
      const role = nycRoles[row.relationship_type_code]; if (!role) continue;
      const relationshipType = classifyRole(role);
      const name = [row.person_name_first, row.person_name_middle, row.person_name_last, row.person_name_suffix].filter(Boolean).join(" ");
      if (!name) continue;
      const companyMatch = debug.companyMatches.find((match) => normalize(match.companyName) === normalize(row.organization_name))!;
      debug.people.push({ name, role, relationshipType, sourceName: debug.sourceName, sourceUrl: peopleUrl, evidenceText: `${name} — ${role} (${row.relationship_type_code}) for ${row.organization_name}.`, companyMatchEvidence: companyMatch.evidence, identityConfidence: Math.min(96, 70 + Math.round(companyMatch.score * 0.2)) });
    }
  }
  debug.status = debug.companyMatches.length ? "matched" : "empty";
  debug.reason ||= debug.companyMatches.length ? undefined : "No NYC organization passed name and phone/state matching.";
  return debug;
}

export async function searchDirectOwnerSources(business: Business) {
  return Promise.all([searchConnecticutRegistry(business), searchNycDoingBusiness(business)]);
}
