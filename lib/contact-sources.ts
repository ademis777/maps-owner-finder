import type { Business } from "./maps";
import { scoreCompanyMatch } from "./owner-sources.ts";
import * as cheerio from "cheerio";
import { get as httpsGet } from "node:https";
// The package root runs its bundled demo in webpack; this is the parser-only entry.
// @ts-expect-error pdf-parse does not publish a declaration for this internal runtime entry.
import pdf from "pdf-parse/lib/pdf-parse.js";

export type RawProfessionalContact = {
  kind: "phone" | "email";
  value: string;
  normalizedValue: string;
  personName: string;
  companyName: string;
  sourceName: string;
  sourceUrl: string;
  evidenceText: string;
  relatedBusinessPhones?: string[];
};

export type ContactSourceDebug = {
  sourceName: string;
  attempted: boolean;
  input: string;
  status: "matched" | "empty" | "skipped" | "blocked" | "timeout" | "error";
  candidatesFound: RawProfessionalContact[];
  acceptedCandidates: Array<RawProfessionalContact & { contactType: string; confidence: number; reason: string }>;
  rejectedCandidates: Array<{ value?: string; sourceUrl: string; reason: string; evidenceText: string }>;
  reason?: string;
  searchQuery?: string;
  carrierMatches?: string[];
  personMatch?: boolean;
  mcUsd?: string;
  historicalPhone?: string;
  currentCompanyPhone?: string;
  classificationReason?: string;
  durationMs?: number;
  discoveryQueries?: string[];
  documentsFound?: Array<{ title: string; url: string }>;
  documentsAccepted?: string[];
  documentsRejected?: Array<{ url: string; reason: string }>;
  nameReconciliation?: string;
};

const normalize = (value?: string) => (value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const normalizePhone = (value: string) => { const digits = value.replace(/\D/g, ""); return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits; };
const normalizeContact = (kind: "phone" | "email", value: string) => kind === "phone" ? normalizePhone(value) : value.trim().toLowerCase();
const stateOf = (business: Business) => /\b(?:CT|Connecticut)\b/i.test(business.address || "") ? "CT" : /\b(?:NY|New York)\b/i.test(business.address || "") ? "NY" : "";
const exactPerson = (expected: string, first?: string, last?: string, combined?: string) => normalize(expected) === normalize(combined || [first, last].filter(Boolean).join(" "));
const url = (domain: string, id: string, params: Record<string, string>) => `https://${domain}/resource/${id}.json?${new URLSearchParams(params)}`;

async function json(urlValue: string) {
  try {
    const response = await fetch(urlValue, { cache: "no-store", signal: AbortSignal.timeout(6000), headers: { "user-agent": "MapsOwnerFinder/0.1 public-professional-record-research" } });
    if (response.status === 403 || response.status === 429) return { status: "blocked" as const, reason: `HTTP ${response.status}`, rows: [] as Record<string, string>[] };
    if (!response.ok) return { status: "error" as const, reason: `HTTP ${response.status}`, rows: [] as Record<string, string>[] };
    return { status: "ok" as const, rows: await response.json() as Record<string, string>[] };
  } catch (error) {
    const timeout = error instanceof Error && error.name === "TimeoutError";
    return { status: timeout ? "timeout" as const : "error" as const, reason: error instanceof Error ? error.message : "request failed", rows: [] as Record<string, string>[] };
  }
}

function base(sourceName: string, personName: string, business: Business): ContactSourceDebug {
  return { sourceName, attempted: false, input: `${personName} | ${business.name || ""} | ${business.address || ""}`, status: "skipped", candidatesFound: [], acceptedCandidates: [], rejectedCandidates: [] };
}

type FmcsaSearchHit = { title: string; url: string; snippet: string; entityName?: string; mc?: string; usdot?: string; currentPhone?: string };
type FmcsaOptions = {
  search?: (query: string) => Promise<FmcsaSearchHit[]>;
  fetchText?: (url: string) => Promise<{ status: "ok" | "blocked" | "timeout" | "error"; text?: string; reason?: string }>;
  currentCarrier?: (mcNumber: string) => Promise<{ phone?: string; usdot?: string; entityName?: string; state?: string }>;
};

const FMCSA_REGISTER = /li-public\.fmcsa\.dot\.gov\/lihtml\/rptspdf\/LI_REGISTER\d{8}\.PDF/i;
const transportContext = (business: Business) => /\b(?:tow(?:ing)?|transport(?:ation)?|truck(?:ing)?|carrier|hauling|freight|auto(?:motive)?|roadside)\b/i.test(`${business.name || ""} ${business.category || ""}`);
export const shouldRunFmcsaContact = transportContext;

type PublicDocumentHit = { title: string; url: string; snippet: string };
type PublicDocumentFetch = { status: "ok" | "blocked" | "timeout" | "error"; text?: string; reason?: string; documentTitle?: string; documentDate?: string };
type PublicDocumentOptions = {
  search?: (query: string) => Promise<{ status: "ok" | "empty" | "blocked" | "timeout" | "error"; hits: PublicDocumentHit[]; reason?: string }>;
  fetchDocument?: (url: string) => Promise<PublicDocumentFetch>;
};

const OFFICIAL_DOCUMENT_HOST = /(?:^|\.)(?:mta\.info|nyc\.gov|data\.cityofnewyork\.us|ny\.gov|data\.ny\.gov|[^.]+\.gov)$/i;
const legalTokens = new Set(["inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "company", "co"]);
const suffixTokens = new Set(["jr", "sr", "ii", "iii", "iv"]);
const normalizeCompany = (value?: string) => normalize(value).split(" ").filter((token) => !legalTokens.has(token)).join(" ");
const nameParts = (value: string) => {
  const tokens = normalize(value).split(" ").filter(Boolean);
  if (suffixTokens.has(tokens.at(-1) || "")) tokens.pop();
  return { first: tokens[0] || "", last: tokens.at(-1) || "", tokens };
};

export function reconcilePublicDocumentPerson(expected: string, found: string, strongCompanyMatch: boolean) {
  const left = nameParts(expected); const right = nameParts(found);
  if (!left.first || !left.last || left.last !== right.last) return { matched: false, reason: "Surname did not match the confirmed person." };
  if (normalize(expected) === normalize(found)) return { matched: true, reason: "Exact normalized person name matched." };
  const firstMatches = left.first === right.first;
  const cautiousVariant = new Set([left.first, right.first]).size === 2 && [left.first, right.first].every((value) => value === "charle" || value === "charles");
  if (strongCompanyMatch && (firstMatches || cautiousVariant)) {
    return { matched: true, reason: `${cautiousVariant ? "Charle/Charles variant" : "First and surname"} reconciled with strong exact-company evidence; middle initials and suffix were treated as non-conflicting.` };
  }
  return { matched: false, reason: "Non-exact person name lacked the required strong company evidence." };
}

function officialDocumentUrl(sourceUrl: string) {
  try { return OFFICIAL_DOCUMENT_HOST.test(new URL(sourceUrl).hostname); } catch { return false; }
}

function publicPersonSearchName(personName: string) {
  const parts = nameParts(personName);
  const first = parts.first === "charle" ? "Charles" : parts.first.replace(/^./, (value) => value.toUpperCase());
  const last = parts.last.replace(/^./, (value) => value.toUpperCase());
  return `${first} ${last}`.trim();
}

async function searchBravePublicDocuments(query: string) {
  try {
    const target = `https://search.brave.com/search?${new URLSearchParams({ q: query, source: "web" })}`;
    const response = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const request = httpsGet(target, { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36", "accept-language": "en-US,en;q=0.9" } }, (incoming) => {
        let text = ""; incoming.setEncoding("utf8"); incoming.on("data", (chunk) => { if (text.length < 2_000_000) text += chunk; }); incoming.on("end", () => resolve({ status: incoming.statusCode || 0, text }));
      });
      request.setTimeout(6000, () => request.destroy(Object.assign(new Error("Public-document discovery timed out."), { name: "TimeoutError" })));
      request.on("error", reject);
    });
    if (response.status === 403 || response.status === 429) return { status: "blocked" as const, hits: [], reason: `Brave returned HTTP ${response.status}.` };
    if (response.status < 200 || response.status >= 300) return { status: "error" as const, hits: [], reason: `Brave returned HTTP ${response.status}.` };
    const $ = cheerio.load(response.text);
    const hits: PublicDocumentHit[] = [];
    $("div.snippet[data-type='web']").each((_, element) => {
      const anchor = $(element).find("a[href^='http']").first();
      const sourceUrl = anchor.attr("href") || "";
      if (!officialDocumentUrl(sourceUrl)) return;
      hits.push({ title: $(element).find(".search-snippet-title").first().text().trim(), url: sourceUrl, snippet: $(element).find(".generic-snippet .content").first().text().replace(/\s+/g, " ").trim() });
    });
    return { status: hits.length ? "ok" as const : "empty" as const, hits, reason: hits.length ? undefined : "No official public-document results were parsed." };
  } catch (error) {
    const timeout = error instanceof Error && error.name === "TimeoutError";
    return { status: timeout ? "timeout" as const : "error" as const, hits: [], reason: error instanceof Error ? error.message : "Public-document discovery failed." };
  }
}

async function fetchPublicDocument(sourceUrl: string): Promise<PublicDocumentFetch> {
  try {
    const response = await fetch(sourceUrl, { cache: "no-store", signal: AbortSignal.timeout(7000), headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36", accept: "application/pdf,text/html,text/csv,application/json,*/*" } });
    if (response.status === 403 || response.status === 429) return { status: "blocked", reason: `Official document returned HTTP ${response.status}.` };
    if (!response.ok) return { status: "error", reason: `Official document returned HTTP ${response.status}.` };
    const contentType = response.headers.get("content-type") || "";
    if (/pdf/i.test(contentType)) {
      const parsed = await pdf(Buffer.from(await response.arrayBuffer()));
      return { status: "ok", text: parsed.text.replace(/\r/g, "") };
    }
    const text = await response.text();
    if (/json/i.test(contentType)) return { status: "ok", text: JSON.stringify(JSON.parse(text), null, 2) };
    if (/html/i.test(contentType)) {
      const $ = cheerio.load(text); $("script,style,noscript").remove();
      return { status: "ok", text: $("table").length ? $("table").text().replace(/\s+/g, " ") : $("body").text().replace(/\s+/g, " "), documentTitle: $("title").text().trim() };
    }
    return { status: "ok", text };
  } catch (error) {
    const timeout = error instanceof Error && error.name === "TimeoutError";
    return { status: timeout ? "timeout" : "error", reason: error instanceof Error ? error.message : "Official document fetch failed." };
  }
}

function findPublicDocumentPerson(text: string, expected: string, companyMatches: boolean) {
  const parts = nameParts(expected);
  if (!parts.first || !parts.last) return undefined;
  const firstNames = parts.first === "charle" ? ["charle", "charles"] : [parts.first];
  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b(${firstNames.map(escaped).join("|")})(?:\\s+[A-Z](?:\\.|[A-Za-z'-]+)){0,3}\\s+${escaped(parts.last)}(?:\\s+(?:Jr|Sr|II|III|IV)\\.?)?\\b`, "ig");
  for (const match of text.matchAll(pattern)) {
    const reconciled = reconcilePublicDocumentPerson(expected, match[0], companyMatches);
    if (reconciled.matched) return { found: match[0], index: match.index || 0, reason: reconciled.reason };
  }
  return undefined;
}

export function parseStructuredPublicDocumentContact(text: string, personName: string, business: Business, sourceUrl: string, sourceName = "PUBLIC DOCUMENT CONTACT ENRICHMENT") {
  const companyName = business.name || "";
  const companyMatch = Boolean(normalizeCompany(companyName)) && normalize(text).includes(normalizeCompany(companyName));
  if (!companyMatch) return { candidates: [] as RawProfessionalContact[], rejected: [{ sourceUrl, evidenceText: text.slice(0, 700), reason: "Official document did not contain the confirmed company/vendor identity." }] };
  const person = findPublicDocumentPerson(text, personName, companyMatch);
  if (!person) return { candidates: [] as RawProfessionalContact[], rejected: [{ sourceUrl, evidenceText: text.slice(0, 700), reason: "Official document did not contain an exact or cautiously reconciled confirmed person." }] };
  const companyIndex = normalize(text).indexOf(normalizeCompany(companyName));
  const rowStart = Math.max(0, Math.min(companyIndex < 0 ? person.index : companyIndex, person.index) - 100);
  const row = text.slice(rowStart, Math.min(text.length, Math.max(person.index + person.found.length + 240, rowStart + 500))).replace(/[‐‑‒–—−]/g, "-").replace(/\s+/g, " ").trim();
  const emails = (row.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).slice(0, 1);
  const phones = (row.match(/(?:\+?1[\s/.-]?)?(?:\(?\d{3}\)?[\s/.-]?)\d{3}[\s/.-]\d{4}/g) || []).slice(0, 1);
  const evidencePrefix = `Official procurement/vendor structured row: Vendor = ${companyName} | Contact Name = ${person.found}`;
  const reconciliation = `Name reconciliation: ${personName} ↔ ${person.found}: ${person.reason}`;
  const candidates: RawProfessionalContact[] = [];
  for (const value of [...new Set(emails)]) candidates.push({ kind: "email", value, normalizedValue: normalizeContact("email", value), personName, companyName, sourceName, sourceUrl, evidenceText: `${evidencePrefix} | Email ID = ${value}. ${reconciliation}. Row evidence: ${row}` });
  for (const value of [...new Set(phones)]) candidates.push({ kind: "phone", value, normalizedValue: normalizePhone(value), personName, companyName, sourceName, sourceUrl, evidenceText: `${evidencePrefix} | Telephone = ${value}. ${reconciliation}. Row evidence: ${row}`, relatedBusinessPhones: business.phone ? [business.phone] : [] });
  return { candidates, rejected: candidates.length ? [] : [{ sourceUrl, evidenceText: row, reason: "Structured vendor/person row contained no phone or email field." }], personFound: person.found, reconciliation: person.reason };
}

export async function searchPublicDocumentContact(personName: string, business: Business, options: PublicDocumentOptions = {}): Promise<ContactSourceDebug> {
  const started = performance.now();
  const debug = base("PUBLIC DOCUMENT CONTACT ENRICHMENT", personName, business);
  debug.attempted = true; debug.status = "empty"; debug.documentsFound = []; debug.documentsAccepted = []; debug.documentsRejected = [];
  const shortPerson = publicPersonSearchName(personName);
  const queries = [
    `site:mta.info/document ${business.name} ${shortPerson}`,
    `"${business.name}" "${shortPerson}" procurement site:nyc.gov`,
    `"${business.name}" vendor contact filetype:pdf`,
  ];
  debug.discoveryQueries = queries;
  const search = options.search || searchBravePublicDocuments;
  const fetchDocument = options.fetchDocument || fetchPublicDocument;
  for (const query of queries) {
    debug.searchQuery = query;
    const response = await search(query);
    if (response.status === "blocked" || response.status === "timeout" || response.status === "error") { debug.status = response.status; debug.reason = response.reason; break; }
    for (const hit of response.hits.slice(0, 4)) {
      if (!officialDocumentUrl(hit.url) || debug.documentsFound.some((item) => item.url === hit.url)) continue;
      debug.documentsFound.push({ title: hit.title, url: hit.url });
      const document = await fetchDocument(hit.url);
      const direct = document.status === "ok" && document.text ? parseStructuredPublicDocumentContact(document.text, personName, business, hit.url, debug.sourceName) : undefined;
      const indexedText = `${hit.title}. ${hit.snippet}`;
      const indexed = parseStructuredPublicDocumentContact(indexedText, personName, business, hit.url, debug.sourceName);
      const parsed = direct?.candidates.length ? direct : indexed;
      if (!parsed.candidates.length) {
        const reason = document.status === "ok" ? parsed.rejected[0]?.reason || "No structured contact row." : `${document.reason || document.status}; indexed result also lacked a structured contact row.`;
        debug.documentsRejected.push({ url: hit.url, reason }); debug.rejectedCandidates.push({ sourceUrl: hit.url, evidenceText: indexedText, reason }); continue;
      }
      debug.candidatesFound.push(...parsed.candidates); debug.documentsAccepted.push(hit.url); debug.personMatch = true; debug.nameReconciliation = parsed.reconciliation;
      debug.status = "matched"; debug.reason = document.status === "ok" ? "Official public document contained a structured vendor + named contact + contact field association." : "Official document was discovered and its indexed structured vendor row contained a named contact field; direct document fetch was blocked.";
      debug.durationMs = Math.round(performance.now() - started);
      return debug;
    }
  }
  debug.reason ||= debug.documentsFound.length ? "Official documents were checked but no structured company + confirmed person + contact field was established." : "No relevant official public documents were discovered.";
  debug.durationMs = Math.round(performance.now() - started);
  return debug;
}

type FmcsaCensusEntity = { legal_name?: string; company_officer_1?: string; company_officer_2?: string; phy_city?: string; phy_state?: string; phy_zip?: string; add_date?: string; dot_number?: string; docket1prefix?: string; docket1?: string; phone?: string };

async function discoverFmcsaRegisterHits(personName: string, business: Business, fetchText: NonNullable<FmcsaOptions["fetchText"]>) {
  const queryUrl = url("data.transportation.gov", "az4n-8mr2", { "$q": personName, "$limit": "25" });
  const response = await json(queryUrl);
  if (response.status !== "ok") return { queryUrl, status: response.status, reason: response.reason, entities: [] as FmcsaCensusEntity[], hits: [] as FmcsaSearchHit[] };
  const expectedState = stateOf(business) || business.state?.toUpperCase() || "";
  const entities = (response.rows as FmcsaCensusEntity[]).filter((row) => {
    const personMatches = [row.company_officer_1, row.company_officer_2].some((name) => normalize(name) === normalize(personName));
    const locationMatches = (!expectedState || row.phy_state?.toUpperCase() === expectedState) && (!business.city || normalize(row.phy_city) === normalize(business.city));
    return personMatches && locationMatches && Boolean(row.docket1) && transportContext({ ...business, name: `${business.name || ""} ${row.legal_name || ""}` });
  }).sort((a, b) => Number(Boolean(b.docket1)) - Number(Boolean(a.docket1)));
  const hits: FmcsaSearchHit[] = [];
  for (const entity of entities) {
    if (!/^\d{8}$/.test(entity.add_date || "")) continue;
    const added = new Date(Date.UTC(Number(entity.add_date!.slice(0, 4)), Number(entity.add_date!.slice(4, 6)) - 1, Number(entity.add_date!.slice(6, 8))));
    for (let offset = 0; offset <= 7; offset++) {
      const date = new Date(added); date.setUTCDate(added.getUTCDate() + offset);
      if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
      const stamp = `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
      const sourceUrl = `https://li-public.fmcsa.dot.gov/lihtml/rptspdf/LI_REGISTER${stamp}.PDF`;
      const document = await fetchText(sourceUrl);
      if (document.status === "ok" && document.text && normalize(document.text).includes(normalize(personName))) {
        hits.push({ title: `LI_REGISTER${stamp}.PDF`, url: sourceUrl, snippet: document.text, entityName: entity.legal_name, mc: entity.docket1, usdot: entity.dot_number, currentPhone: entity.phone });
        break;
      }
      if (document.status === "blocked") return { queryUrl, status: document.status, reason: `${sourceUrl}: ${document.reason || document.status}`, entities, hits };
    }
    if (hits.length) break;
  }
  return { queryUrl, status: "ok" as const, entities, hits };
}

async function fetchFmcsaDocument(sourceUrl: string) {
  try {
    const response = await fetch(sourceUrl, { cache: "no-store", signal: AbortSignal.timeout(6000), headers: { "user-agent": "MapsOwnerFinder/0.1 public-professional-record-research", accept: "application/pdf" } });
    if (response.status === 403 || response.status === 429) return { status: "blocked" as const, reason: `HTTP ${response.status}` };
    if (!response.ok) return { status: "error" as const, reason: `HTTP ${response.status}` };
    const parsed = await pdf(Buffer.from(await response.arrayBuffer()));
    return { status: "ok" as const, text: parsed.text.replace(/\r/g, "") };
  } catch (error) {
    const timeout = error instanceof Error && error.name === "TimeoutError";
    return { status: timeout ? "timeout" as const : "error" as const, reason: error instanceof Error ? error.message : "FMCSA PDF request failed" };
  }
}

function parseFmcsaBlock(text: string, personName: string, expected: Pick<FmcsaSearchHit, "entityName" | "mc"> = {}) {
  const index = normalize(text).indexOf(normalize(personName));
  if (index < 0) return undefined;
  const personPattern = personName.trim().split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  const rawIndex = text.search(new RegExp(personPattern, "i"));
  if (rawIndex < 0) return undefined;
  const pageMarkers = [...text.matchAll(/Page\s+\d+\s+of\s+\d+/gi)].map((match) => match.index!);
  const pageStart = pageMarkers.filter((position) => position < rawIndex).at(-1) ?? Math.max(0, rawIndex - 3500);
  const pageEnd = pageMarkers.find((position) => position > rawIndex) ?? Math.min(text.length, rawIndex + 5000);
  const page = text.slice(pageStart, pageEnd).replace(/[ \t]+/g, " ");
  const mcLines = [...page.matchAll(/^MC[-\s]?(\d{5,8})\s*$/gim)].map((match) => match[1]);
  const phoneLines = [...page.matchAll(/^Tel\s*:\s*(\+?1?[\s().-]*\d{3}[\s().-]*\d{3}[\s.-]*\d{4})\s*$/gim)].map((match) => match[1].trim());
  const mc = expected.mc && mcLines.includes(expected.mc) ? expected.mc : mcLines[0];
  const recordIndex = mc ? mcLines.indexOf(mc) : -1;
  const phone = recordIndex >= 0 ? phoneLines[recordIndex] : undefined;
  const entityName = expected.entityName && normalize(page).includes(normalize(expected.entityName)) ? expected.entityName : page.match(/(?:^|\n)\s*([A-Z0-9][A-Z0-9 '&.,/-]{3,80}(?:LLC|INC|CORP(?:ORATION)?))\s*(?:\n|$)/m)?.[1]?.trim();
  const date = page.match(/\b(\d{2}\/\d{2}\/\d{4})\b/)?.[1];
  const location = page.match(/\b[A-Z][A-Z .'-]+,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/)?.[0];
  const block = [entityName, personName.toUpperCase(), location, phone && `Tel: ${phone}`, mc && `MC-${mc}`, date].filter(Boolean).join("\n");
  return { block, mc, phone, entityName, date };
}

async function fetchCurrentCarrier(mcNumber: string) {
  try {
    const sourceUrl = `https://safer.fmcsa.dot.gov/query.asp?query_param=MC_MX&query_string=${encodeURIComponent(mcNumber)}&query_type=queryCarrierSnapshot&searchtype=ANY`;
    const response = await fetch(sourceUrl, { cache: "no-store", signal: AbortSignal.timeout(5000), headers: { "user-agent": "Mozilla/5.0", "accept-language": "en-US,en;q=0.9" } });
    if (!response.ok) return {};
    const text = cheerio.load(await response.text())("body").text().replace(/\s+/g, " ");
    return { phone: text.match(/Phone:\s*(\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4})/i)?.[1], usdot: text.match(/USDOT Number:\s*(\d+)/i)?.[1], entityName: text.match(/Legal Name:\s*([^]+?)\s+(?:DBA Name:|Physical Address:)/i)?.[1]?.trim(), state: text.match(/Physical Address:[^]+?\b([A-Z]{2})\s+\d{5}\b/i)?.[1] };
  } catch { return {}; }
}

export async function searchFmcsaContact(personName: string, business: Business, options: FmcsaOptions = {}): Promise<ContactSourceDebug> {
  const debug = base("FMCSA CONTACT ENRICHMENT", personName, business);
  const state = stateOf(business) || business.state?.toUpperCase() || "";
  if (!transportContext(business)) { debug.reason = "Skipped: company name/category has no transportation, towing, trucking, carrier, or roadside context."; return debug; }
  if (!state) { debug.reason = "Skipped: a US state is required for FMCSA entity validation."; return debug; }
  debug.attempted = true;
  const fetchText = options.fetchText || fetchFmcsaDocument;
  let hits: FmcsaSearchHit[];
  if (options.search) {
    debug.searchQuery = `injected FMCSA register search for ${personName}`;
    hits = await options.search(debug.searchQuery);
  } else {
    const discovery = await discoverFmcsaRegisterHits(personName, business, fetchText);
    debug.searchQuery = discovery.queryUrl;
    debug.carrierMatches = discovery.entities.map((entity) => `${entity.legal_name || "unknown entity"}${entity.docket1 ? ` | ${entity.docket1prefix || "MC"}-${entity.docket1}` : ""}${entity.dot_number ? ` | USDOT ${entity.dot_number}` : ""}${entity.add_date ? ` | ADD_DATE ${entity.add_date}` : ""}`);
    if (discovery.status !== "ok") { debug.status = discovery.status; debug.reason = discovery.reason; return debug; }
    hits = discovery.hits;
  }
  if (!hits.length) { debug.status = "empty"; debug.reason = "Official Company Census matched no exact person/location entity with a register PDF containing that person within ADD_DATE through ADD_DATE + 7 days."; return debug; }
  const currentCarrier = options.currentCarrier || fetchCurrentCarrier;
  for (const hit of hits.filter((item) => FMCSA_REGISTER.test(item.url))) {
    const document = options.search && hit.snippet ? { status: "ok" as const, text: hit.snippet } : hit.snippet && normalize(hit.snippet).includes(normalize(personName)) ? { status: "ok" as const, text: hit.snippet } : await fetchText(hit.url);
    if (document.status !== "ok" || !document.text) { debug.rejectedCandidates.push({ sourceUrl: hit.url, evidenceText: hit.snippet, reason: `Official register could not be read: ${document.reason || document.status}.` }); continue; }
    const parsed = parseFmcsaBlock(document.text, personName, hit);
    if (!parsed?.phone || !parsed.mc || !parsed.entityName) { debug.rejectedCandidates.push({ sourceUrl: hit.url, evidenceText: document.text.slice(0, 900), reason: "Register result lacked a structured exact-person + entity + Tel + MC block." }); continue; }
    debug.carrierMatches = [...(debug.carrierMatches || []), parsed.entityName];
    debug.personMatch = normalize(document.text).includes(normalize(personName));
    const locationMatches = new RegExp(`\\b${state}\\b`, "i").test(parsed.block) && (!business.city || normalize(parsed.block).includes(normalize(business.city)));
    if (!debug.personMatch || !locationMatches) { debug.rejectedCandidates.push({ value: parsed.phone, sourceUrl: hit.url, evidenceText: parsed.block, reason: `Rejected: ${!debug.personMatch ? "exact person did not match" : "city/state did not match the original company"}.` }); continue; }
    const current = await currentCarrier(parsed.mc);
    if (current.state && current.state.toUpperCase() !== state) { debug.rejectedCandidates.push({ value: parsed.phone, sourceUrl: hit.url, evidenceText: parsed.block, reason: "Current FMCSA entity resolves to a different state." }); continue; }
    debug.mcUsd = `MC-${parsed.mc}${current.usdot ? ` / USDOT ${current.usdot}` : ""}`;
    debug.historicalPhone = parsed.phone;
    debug.currentCompanyPhone = current.phone;
    const evidenceText = `${parsed.entityName}\n${personName.toUpperCase()}\nTel: ${parsed.phone}\nMC-${parsed.mc}${current.usdot ? `\nUSDOT ${current.usdot}` : ""}${parsed.date ? `\nRecord date: ${parsed.date}` : ""}\nMatched to ${business.name} by exact person, ${business.city || "location"}, ${state}, and transportation/towing context.${current.phone ? ` Current FMCSA company phone: ${current.phone}.` : ""}`;
    debug.candidatesFound.push({ kind: "phone", value: parsed.phone, normalizedValue: normalizePhone(parsed.phone), personName, companyName: business.name || parsed.entityName, sourceName: debug.sourceName, sourceUrl: hit.url, evidenceText, relatedBusinessPhones: current.phone ? [current.phone] : [] });
  }
  debug.status = debug.candidatesFound.length ? "matched" : debug.rejectedCandidates.some((item) => /blocked|HTTP 403|HTTP 429/i.test(item.reason)) ? "blocked" : "empty";
  debug.reason ||= debug.candidatesFound.length ? "Exact person, transportation context, and geographic evidence matched an FMCSA register entity." : "FMCSA results did not establish the required person + geography + transportation relationship.";
  return debug;
}

export async function searchNycDobLicense(personName: string, business: Business): Promise<ContactSourceDebug> {
  const debug = base("NYC DOB License Info", personName, business);
  if (stateOf(business) !== "NY") { debug.reason = "Skipped: source covers New York licensees only."; return debug; }
  debug.attempted = true;
  const sourceUrl = url("data.cityofnewyork.us", "t8hj-ruu2", { "$q": personName, "$limit": "30" });
  const response = await json(sourceUrl);
  if (response.status !== "ok") { debug.status = response.status; debug.reason = response.reason; return debug; }
  for (const row of response.rows) {
    const evidence = `${row.first_name || ""} ${row.last_name || ""} | ${row.business_name || ""} | ${row.license_type || "professional license"} | business phone ${row.business_phone_number || "not published"} | business email ${row.business_email || "not published"}`.trim();
    if (!exactPerson(personName, row.first_name, row.last_name)) { debug.rejectedCandidates.push({ sourceUrl, reason: "License belongs to a different person.", evidenceText: evidence }); continue; }
    const match = scoreCompanyMatch(business, { name: row.business_name || "", city: row.license_business_city, state: row.business_state, zip: row.business_zip_code });
    if (!match.accepted) { debug.rejectedCandidates.push({ sourceUrl, reason: `Person matched, but company/location did not: ${match.evidence}.`, evidenceText: evidence }); continue; }
    for (const [kind, value] of [["phone", row.business_phone_number], ["email", row.business_email]] as const) if (value) debug.candidatesFound.push({ kind, value, normalizedValue: normalizeContact(kind, value), personName, companyName: business.name || row.business_name, sourceName: debug.sourceName, sourceUrl, evidenceText: `${personName} professional license record for ${row.business_name}. ${kind === "phone" ? "Business phone" : "Business email"}: ${value}. ${match.evidence}.` });
  }
  debug.status = debug.candidatesFound.length ? "matched" : "empty";
  debug.reason ||= response.rows.length ? "Rows were checked, but no contact had both exact person and company/location evidence." : "No license rows found for this person.";
  return debug;
}

export async function searchNycDcwpApplications(personName: string, business: Business): Promise<ContactSourceDebug> {
  const debug = base("NYC DCWP License Applications", personName, business);
  if (stateOf(business) !== "NY") { debug.reason = "Skipped: source covers New York City license applications only."; return debug; }
  debug.attempted = true;
  const sourceUrl = url("data.cityofnewyork.us", "ptev-4hud", { "$q": personName, "$limit": "30" });
  const companyQuery = normalize(business.name).split(" ").filter((token) => !["inc", "llc", "ltd", "corp", "corporation", "company", "co"].includes(token)).join(" ");
  const fallbackUrl = url("data.cityofnewyork.us", "ptev-4hud", { "$q": companyQuery || business.name || personName, "$limit": "30" });
  const first = await json(sourceUrl); const second = await json(fallbackUrl);
  const failed = first.status !== "ok" ? first : second.status !== "ok" ? second : undefined;
  if (failed) { debug.status = failed.status; debug.reason = failed.reason; return debug; }
  const rows = [...first.rows, ...second.rows].filter((row, index, all) => all.findIndex((item) => item.application_id === row.application_id) === index);
  for (const row of rows) {
    if (!row.contact_phone) continue;
    const applicantMatches = exactPerson(personName, undefined, undefined, row.business_name);
    const companyRecordName = row.dba_trade_name || row.business_name || "";
    const match = scoreCompanyMatch(business, { name: companyRecordName, city: row.city, state: row.state, zip: row.zip, phone: row.contact_phone });
    const evidence = `${row.business_name || ""} | DBA ${row.dba_trade_name || "not provided"} | ${row.business_category || "license application"} | contact phone ${row.contact_phone}`;
    if (!applicantMatches) { debug.rejectedCandidates.push({ value: row.contact_phone, sourceUrl: fallbackUrl, reason: "Contact phone belongs to a company application; applicant is not the confirmed person.", evidenceText: evidence }); continue; }
    if (!match.accepted) { debug.rejectedCandidates.push({ value: row.contact_phone, sourceUrl, reason: `Applicant matched, but company/location did not: ${match.evidence}.`, evidenceText: evidence }); continue; }
    debug.candidatesFound.push({ kind: "phone", value: row.contact_phone, normalizedValue: normalizePhone(row.contact_phone), personName, companyName: business.name || companyRecordName, sourceName: debug.sourceName, sourceUrl, evidenceText: `${personName} is the named license applicant for ${companyRecordName}; contact phone ${row.contact_phone}. ${match.evidence}.` });
  }
  debug.status = debug.candidatesFound.length ? "matched" : "empty";
  debug.reason ||= rows.length ? "Applications were checked, but no phone was attributable to both the person and company." : "No matching applications found.";
  return debug;
}

export async function searchCtProfessionalLicenses(personName: string, business: Business): Promise<ContactSourceDebug> {
  const debug = base("Connecticut State Licenses and Credentials", personName, business);
  if (stateOf(business) !== "CT") { debug.reason = "Skipped: source covers Connecticut credentials only."; return debug; }
  debug.attempted = true;
  const escaped = personName.toUpperCase().replace(/"/g, '""');
  const sourceUrl = url("data.ct.gov", "ngch-56tr", { "$where": `upper(name) = "${escaped}"`, "$limit": "50" });
  const response = await json(sourceUrl);
  if (response.status !== "ok") { debug.status = response.status; debug.reason = response.reason; return debug; }
  for (const row of response.rows) {
    const recordCompany = row.businessname || row.dba || "";
    const match = scoreCompanyMatch(business, { name: recordCompany, address: row.address, city: row.city, state: row.state, zip: row.zip });
    if (!recordCompany || !match.accepted) debug.rejectedCandidates.push({ sourceUrl, reason: `Credential does not match the confirmed company/location: ${match.evidence}.`, evidenceText: `${row.name || ""} | ${recordCompany || "no business listed"} | ${row.credential || "credential"} | ${row.city || ""}, ${row.state || ""}` });
  }
  debug.status = "empty";
  debug.reason = response.rows.length ? "Credential rows were checked; this dataset publishes no phone or email fields." : "No credential rows found for this person.";
  return debug;
}

export function searchProfessionalContactSources(personName: string, business: Business) {
  return Promise.all([searchCtProfessionalLicenses(personName, business), searchNycDobLicense(personName, business), searchNycDcwpApplications(personName, business)]);
}
