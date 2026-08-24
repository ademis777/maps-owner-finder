import * as cheerio from "cheerio";
import type { Business } from "./maps";
import { classifyRole, type RelationshipType, type SourceDebug } from "./owner-sources.ts";
import { detectState, searchStateRegistries } from "./state-registry.ts";
import { searchFmcsaContact, searchProfessionalContactSources, searchPublicDocumentContact, shouldRunFmcsaContact, type ContactSourceDebug } from "./contact-sources.ts";

type OwnerEvidenceSource = { label: string; url: string; snippet?: string; phones?: string[]; emails?: string[]; sourceName?: string; evidenceText?: string; companyMatchEvidence?: string; relationshipType?: RelationshipType };

export type OwnerCandidate = {
  name: string;
  title?: string;
  relationshipType: RelationshipType;
  confidence: number;
  phones: string[];
  emails: string[];
  contacts: OwnerContact[];
  sources: OwnerEvidenceSource[];
};

export type ContactType = "verified_direct" | "possible_direct" | "business" | "general_email" | "press_media" | "unknown";
export type OwnerContact = {
  value: string;
  normalizedValue: string;
  personName: string;
  companyName: string;
  sourceName: string;
  sourceUrl: string;
  evidenceText: string;
  contactType: ContactType;
  confidence: number;
  reason: string;
  kind: "phone" | "email";
};

export type OwnerDebug = {
  sources: SourceDebug[];
  contactEnrichment: Array<{ personName: string; companyName: string; sources: ContactSourceDebug[] }>;
  ownerDiscoveryMode: "registry_confirmed" | "registry_no_match_web_fallback" | "registry_ambiguous_web_fallback" | "unsupported_state_web_fallback";
  webFallback: {
    fallbackStarted: boolean;
    budgetMs: number;
    elapsedMs: number;
    queriesPlanned: string[];
    queriesExecuted: string[];
    queriesSkipped: string[];
    ddgCalls: number;
    bingCalls: number;
    pagesFetched: number;
    earlyStopReason?: string;
    budgetExceeded: boolean;
  };
  timing: Array<{ stage: string; status: "completed" | "partial" | "skipped" | "timeout" | "error"; durationMs: number; reason?: string }>;
  queries: Array<{
    query: string;
    duckduckgo: ProviderDebug;
    bing: ProviderDebug;
    results: Array<{
      engine: "duckduckgo" | "bing";
      title: string;
      url: string;
      originalUrl: string;
      snippet: string;
      accepted: boolean;
      relevanceScore: number;
      relevanceReason: string;
      extracted: Array<{ name: string; title: string }>;
    }>;
  }>;
};

export type SearchStatus = "ok" | "empty" | "blocked" | "timeout" | "http_error" | "parse_error" | "skipped";
export type ProviderDebug = {
  status: SearchStatus;
  httpStatus?: number;
  parsedCount: number;
  acceptedCount: number;
  rejectedCount: number;
  reason?: string;
  durationMs?: number;
};

export type BusinessContacts = { phones: string[]; emails: string[] };
export type SearchResult = { title: string; url: string; originalUrl: string; snippet: string; engine: "duckduckgo" | "bing"; accepted: boolean; relevanceScore: number; relevanceReason: string };
type SearchResponse = { status: SearchStatus; httpStatus?: number; reason?: string; results: SearchResult[]; durationMs?: number };

const rolePattern = /(owner|founder|co-founder|president|ceo|managing member|member|principal|proprietor)/i;
const roleExpr = `[Oo]wner|[Ff]ounder|[Cc]o-[Ff]ounder|[Pp]resident|CEO|[Mm]anaging [Mm]ember|[Mm]ember|[Pp]rincipal|[Pp]roprietor`;
const nameWord = `[A-Z][a-zA-Z'-]*`;
const personName = `${nameWord}(?:\\s+${nameWord}){1,2}`;
const blockedWords = new Set(["because","for","and","the","with","from","at","of","in","to","by","is","as","a","an","principal","contacts","customer","business","management","registered","agent","company","service","services"]);
const externalDomains = ["bbb.org","bizapedia.com","opencorporates.com","linkedin.com","manta.com","chamberofcommerce.com","datanyze.com","crunchbase.com","einpresswire.com","prweb.com","prnewswire.com"];

function normalize(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
export function ownerPersonKey(value: string) { const parts = normalize(value).split(" ").filter(Boolean); return parts.filter((part, index) => part.length > 1 || index === 0 || index === parts.length - 1).join(" "); }
function uniq(values: string[]) { return [...new Set(values.map((v) => v.trim()).filter(Boolean))]; }

function looksLikePerson(name: string, businessName: string) {
  const words = name.trim().split(/\s+/);
  const normalized = normalize(name);
  const businessNormalized = normalize(businessName);
  if (!normalized || normalized === businessNormalized) return false;
  if (businessNormalized.includes(normalized) || normalized.includes(businessNormalized)) return false;
  if (words.length < 2 || words.length > 3) return false;
  if (words.some((word) => blockedWords.has(word.toLowerCase()))) return false;
  return words.every((word) => /^[A-Z][a-zA-Z'-]*$/.test(word));
}

function extractPeopleNearRoles(text: string, businessName: string) {
  const matches: Array<{ name: string; title: string }> = [];
  const patterns = [
    new RegExp(`(?:Mr\\.?|Ms\\.?|Mrs\\.?)?\\s*(${personName})\\s*[-–—,:|]\\s*(${roleExpr})\\b`, "g"),
    new RegExp(`\\b(${roleExpr})\\b\\s*(?:of\\s+)?[-–—,:|]?\\s*(?:Mr\\.?|Ms\\.?|Mrs\\.?)?\\s*(${personName})\\b`, "g"),
    new RegExp(`(?:Mr\\.?|Ms\\.?|Mrs\\.?)?\\s*(${personName})\\s+(?:is|was|serves as|works as)\\s+(?:the\\s+)?(${roleExpr})\\b`, "g"),
    new RegExp(`(?:Mr\\.?|Ms\\.?|Mrs\\.?)?\\s*(${personName})\\s*,[^.!?]{0,80}?\\b(${roleExpr})\\b`, "g"),
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      const first = match[1] || "";
      const second = match[2] || "";
      const firstIsRole = rolePattern.test(first);
      const name = (firstIsRole ? second : first).trim();
      const title = (firstIsRole ? first : second).trim();
      if (looksLikePerson(name, businessName)) matches.push({ name, title });
    }
  }
  const seen = new Set<string>();
  return matches.filter((item) => {
    const key = `${normalize(item.name)}|${normalize(item.title)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractPhones(text: string) {
  return uniq(text.match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]\d{4}/g) || []).slice(0, 6);
}
function extractEmails(text: string) {
  return uniq(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).filter((email) => !/example\.(com|org|net)$/i.test(email)).slice(0, 6);
}

export function normalizePhone(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

const generalEmailLocals = new Set(["info", "contact", "office", "sales", "support", "admin", "hello", "service", "customerservice"]);
function isPressSource(url: string, evidence: string) {
  return /(?:prnewswire\.com|prweb\.com|einpresswire\.com)/i.test(url) && /\b(?:media|press|newsroom|media contact|press contact|for further information)\b/i.test(evidence);
}
function hasExplicitPersonalEvidence(evidence: string, ownerName: string, value: string) {
  const escapedName = ownerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const personalLabel = `(?:direct|mobile|cell|personal|direct line|direct email|email directly)`;
  const explicit = new RegExp(`${escapedName}.{0,120}${personalLabel}.{0,60}${escapedValue}|${escapedName}.{0,120}${escapedValue}.{0,60}${personalLabel}`, "i").test(evidence);
  const personalBlock = new RegExp(`${escapedName}.{0,80}(?:${escapedValue}|(?:phone|tel|email)\\s*[:|-])`, "i").test(evidence)
    && /\b(?:profile|contact details|vcard|bio|team|leadership)\b/i.test(evidence);
  return explicit || personalBlock;
}

export function classifyOwnerContact(input: {
  value: string;
  kind: "phone" | "email";
  sourceUrl: string;
  evidenceText: string;
  ownerName: string;
  businessName: string;
  businessPhones?: string[];
  sourceName?: string;
}): OwnerContact {
  const { value, kind, sourceUrl, evidenceText, ownerName, businessName } = input;
  const common = { value, normalizedValue: kind === "phone" ? normalizePhone(value) : value.trim().toLowerCase(), personName: ownerName, companyName: businessName, sourceName: input.sourceName || (() => { try { return new URL(sourceUrl).hostname; } catch { return "Public source"; } })(), kind, sourceUrl, evidenceText };
  if (isPressSource(sourceUrl, evidenceText)) {
    return { ...common, contactType: "press_media", confidence: 96, reason: "Contact appears in a press/media contact block." };
  }
  if (kind === "email") {
    const local = value.split("@")[0]?.toLowerCase().replace(/[^a-z0-9]/g, "") || "";
    if (generalEmailLocals.has(local)) {
      return { ...common, contactType: "general_email", confidence: 98, reason: "Role-based mailbox is a general company email, not a personal address." };
    }
  }

  const explicit = hasExplicitPersonalEvidence(evidenceText, ownerName, value);
  const structuredNamedEmail = kind === "email" && /official procurement\/vendor structured row:[^]+contact name\s*=[^|]+\|\s*email(?: id)?\s*=/i.test(evidenceText);
  const sameBusinessPhone = kind === "phone" && (input.businessPhones || []).some((phone) => normalizePhone(phone) === normalizePhone(value));
  if (sameBusinessPhone && !explicit) {
    return { ...common, contactType: "business", confidence: 98, reason: "Phone matches a known Google Maps/CSV business phone and lacks explicit personal evidence." };
  }
  if (explicit || structuredNamedEmail) {
    return { ...common, contactType: "verified_direct", confidence: structuredNamedEmail ? 92 : 94, reason: structuredNamedEmail ? "Official structured procurement/vendor row explicitly assigns this email field to the named confirmed contact." : "Source explicitly links the contact to the person as direct, mobile, cell, personal, or a personal profile contact." };
  }

  const normalizedEvidence = normalize(evidenceText);
  const hasOwner = normalizedEvidence.includes(normalize(ownerName));
  const hasBusiness = normalizedEvidence.includes(normalize(businessName));
  if (hasOwner && hasBusiness) {
    return { ...common, contactType: "possible_direct", confidence: 68, reason: "Contact is near both the owner name and company name, but no explicit direct/personal label was found." };
  }
  return { ...common, contactType: "unknown", confidence: 30, reason: "Contact lacks enough evidence to attribute it directly to the owner." };
}

function chunksAround(text: string, needle: string, radius = 220) {
  const haystack = text.toLowerCase();
  const target = needle.toLowerCase();
  const chunks: string[] = [];
  let from = 0;
  while (from < haystack.length) {
    const index = haystack.indexOf(target, from);
    if (index === -1) break;
    chunks.push(text.slice(Math.max(0, index - radius), Math.min(text.length, index + target.length + radius)));
    from = index + target.length;
    if (chunks.length >= 6) break;
  }
  return chunks;
}

function extractOwnerContactEvidence(text: string, ownerName: string, businessName: string, sourceUrl: string, businessPhones: string[]) {
  const businessNeedle = normalize(businessName);
  const valid = chunksAround(text, ownerName, 240).filter((chunk) => normalize(chunk).includes(businessNeedle));
  const contacts: OwnerContact[] = [];
  for (const evidenceText of valid) {
    for (const value of extractPhones(evidenceText)) contacts.push(classifyOwnerContact({ value, kind: "phone", sourceUrl, evidenceText, ownerName, businessName, businessPhones }));
    for (const value of extractEmails(evidenceText)) contacts.push(classifyOwnerContact({ value, kind: "email", sourceUrl, evidenceText, ownerName, businessName, businessPhones }));
  }
  const seen = new Set<string>();
  return contacts.filter((contact) => {
    const key = `${contact.kind}|${contact.kind === "phone" ? normalizePhone(contact.value) : contact.value.toLowerCase()}|${contact.sourceUrl}|${contact.contactType}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

export function isExternalSource(url: string) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return externalDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch { return false; }
}

function decodeDuckDuckGoUrl(href: string) {
  try {
    const url = new URL(href, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : url.href;
  } catch { return href; }
}

export function decodeBingUrl(href: string) {
  try {
    const parsed = new URL(href, "https://www.bing.com");
    if (!/(^|\.)bing\.com$/i.test(parsed.hostname) || !parsed.pathname.startsWith("/ck/a")) return parsed.href;
    for (const key of ["u", "url", "r"]) {
      const encoded = parsed.searchParams.get(key);
      if (!encoded) continue;
      if (/^https?:\/\//i.test(encoded)) return encoded;
      const payload = encoded.startsWith("a1") ? encoded.slice(2) : encoded;
      try {
        const decoded = Buffer.from(payload, "base64url").toString("utf8");
        if (/^https?:\/\//i.test(decoded)) return decoded;
      } catch {}
    }
    return parsed.href;
  } catch { return href; }
}

export function classifyDdgResponse(httpStatus: number, html: string, parsedCount: number): { status: SearchStatus; reason?: string } {
  if (httpStatus === 202) return { status: "blocked", reason: "DuckDuckGo returned HTTP 202 challenge response." };
  if (httpStatus === 403 || httpStatus === 429) return { status: "blocked", reason: `DuckDuckGo returned HTTP ${httpStatus}.` };
  if (httpStatus < 200 || httpStatus >= 300) return { status: "http_error", reason: `DuckDuckGo returned HTTP ${httpStatus}.` };
  if (/\b(?:anomaly|captcha|challenge|bot detection|automated requests|verify you are human)\b/i.test(html)) return { status: "blocked", reason: "DuckDuckGo response contains challenge/bot-detection markers." };
  if (parsedCount > 0) return { status: "ok" };
  if (/\b(?:no results|did not match any documents|no more results)\b/i.test(html)) return { status: "empty", reason: "DuckDuckGo returned a normal empty result page." };
  if (!html.trim()) return { status: "parse_error", reason: "DuckDuckGo returned an empty response body." };
  return { status: "parse_error", reason: "DuckDuckGo response lacked both result markup and a normal empty-result marker." };
}

function websiteHost(website?: string) {
  try { return new URL(website || "").hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}
const companyStopWords = new Set(["the", "and", "of", "company", "co", "inc", "llc", "ltd", "corp", "corporation", "services", "service"]);
export function evaluateResultRelevance(result: Pick<SearchResult, "title" | "snippet" | "url">, business: Business) {
  const company = normalize(business.name || "");
  const text = normalize(`${result.title} ${result.snippet}`);
  const tokens = company.split(" ").filter((token) => token.length >= 3 && !companyStopWords.has(token));
  const matchedTokens = tokens.filter((token) => text.split(" ").includes(token));
  const fullName = Boolean(company && text.includes(company));
  const host = (() => { try { return new URL(result.url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } })();
  const siteHost = websiteHost(business.website);
  const domainMatch = Boolean(siteHost && (host === siteHost || host.endsWith(`.${siteHost}`)));
  const locationTokens = normalize(business.address || "").split(" ").filter((token) => token.length >= 4);
  const locationMatches = locationTokens.filter((token) => text.includes(token)).length;
  const requiredTokens = Math.max(1, Math.ceil(tokens.length * 0.6));
  const accepted = fullName || domainMatch || (tokens.length > 0 && matchedTokens.length >= requiredTokens);
  const score = (fullName ? 6 : 0) + matchedTokens.length + (domainMatch ? 5 : 0) + Math.min(2, locationMatches);
  const reason = accepted
    ? `accepted: ${fullName ? "full company name; " : ""}${matchedTokens.length}/${tokens.length} significant tokens${domainMatch ? "; website domain match" : ""}${locationMatches ? `; ${locationMatches} location signals` : ""}`
    : `rejected: only ${matchedTokens.length}/${tokens.length} significant company tokens matched; required ${requiredTokens}`;
  return { accepted, score, reason };
}

function newResult(input: { title: string; href: string; snippet: string; engine: "duckduckgo" | "bing" }): SearchResult {
  const url = input.engine === "bing" ? decodeBingUrl(input.href) : decodeDuckDuckGoUrl(input.href);
  return { title: input.title, url, originalUrl: input.href, snippet: input.snippet, engine: input.engine, accepted: true, relevanceScore: 0, relevanceReason: "not scored" };
}

function parseDdgHtml(html: string): SearchResult[] {
  const $ = cheerio.load(html); const results: SearchResult[] = [];
  $(".result").slice(0, 5).each((_, element) => {
    const title = $(element).find(".result__a").text().trim();
    const href = $(element).find(".result__a").attr("href") || "";
    const snippet = $(element).find(".result__snippet").text().replace(/\s+/g, " ").trim();
    if (title && href) results.push(newResult({ title, href, snippet, engine: "duckduckgo" }));
  }); return results;
}
function parseDdgLite(html: string): SearchResult[] {
  const $ = cheerio.load(html); const results: SearchResult[] = [];
  $("a.result-link").slice(0, 5).each((_, element) => {
    const title = $(element).text().trim(); const href = $(element).attr("href") || "";
    const snippet = $(element).closest("tr").next().text().replace(/\s+/g, " ").trim();
    if (title && href) results.push(newResult({ title, href, snippet, engine: "duckduckgo" }));
  }); return results;
}
function parseBingHtml(html: string): SearchResult[] {
  const $ = cheerio.load(html); const results: SearchResult[] = [];
  $("li.b_algo").slice(0, 5).each((_, element) => {
    const link = $(element).find("h2 a").first(); const title = link.text().trim(); const href = link.attr("href") || "";
    const snippet = $(element).find(".b_caption p, p").first().text().replace(/\s+/g, " ").trim();
    if (title && href) results.push(newResult({ title, href, snippet, engine: "bing" }));
  }); return results;
}

const headers = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36", "accept-language": "en-US,en;q=0.9" };
async function fetchDdg(url: string, parser: (html: string) => SearchResult[], timeout: number): Promise<SearchResponse> {
  try {
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeout), headers });
    const html = await r.text(); const results = parser(html); const classified = classifyDdgResponse(r.status, html, results.length);
    return { ...classified, httpStatus: r.status, results };
  } catch (error) {
    const timeoutError = error instanceof Error && error.name === "TimeoutError";
    return { status: timeoutError ? "timeout" : "http_error", reason: timeoutError ? `DuckDuckGo timed out after ${timeout}ms.` : `DuckDuckGo request failed: ${error instanceof Error ? error.message : "unknown error"}`, results: [] };
  }
}
async function duckDuckGoSearch(query: string): Promise<SearchResponse> {
  const started = performance.now();
  const html = await fetchDdg(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, parseDdgHtml, 1000);
  if (html.status === "ok" || html.status === "blocked") return { ...html, durationMs: Math.round(performance.now() - started) } as SearchResponse;
  const lite = await fetchDdg(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, parseDdgLite, 500);
  if (lite.status === "ok" || lite.status === "empty") return { ...lite, durationMs: Math.round(performance.now() - started) } as SearchResponse;
  return { status: lite.status === "blocked" ? "blocked" : lite.status, httpStatus: lite.httpStatus || html.httpStatus, reason: [html.reason, lite.reason].filter(Boolean).join("; "), results: [], durationMs: Math.round(performance.now() - started) } as SearchResponse;
}
async function bingSearch(query: string): Promise<SearchResponse> {
  const started = performance.now();
  try {
    const r = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en-US`, { cache: "no-store", signal: AbortSignal.timeout(2500), headers });
    if (!r.ok) return { status: r.status === 403 || r.status === 429 ? "blocked" : "http_error", httpStatus: r.status, reason: `Bing returned HTTP ${r.status}.`, results: [], durationMs: Math.round(performance.now() - started) } as SearchResponse;
    const results = parseBingHtml(await r.text());
    return { status: results.length ? "ok" : "empty", httpStatus: r.status, reason: results.length ? undefined : "Bing returned no parsed results.", results, durationMs: Math.round(performance.now() - started) } as SearchResponse;
  } catch (error) {
    const timeoutError = error instanceof Error && error.name === "TimeoutError";
    return { status: timeoutError ? "timeout" : "http_error", reason: timeoutError ? "Bing timed out after 2500ms." : `Bing request failed: ${error instanceof Error ? error.message : "unknown error"}`, results: [], durationMs: Math.round(performance.now() - started) } as SearchResponse;
  }
}
type SearchAnalysisContext = { ddgBlocked: boolean; ddgQueue: Promise<void> };
function createSearchContext(): SearchAnalysisContext { return { ddgBlocked: false, ddgQueue: Promise.resolve() }; }
function ddgForAnalysis(query: string, context: SearchAnalysisContext, provider: (query: string) => Promise<SearchResponse> = duckDuckGoSearch): Promise<SearchResponse> {
  let release!: () => void;
  const previous = context.ddgQueue;
  context.ddgQueue = new Promise<void>((resolve) => { release = resolve; });
  return previous.then(async () => {
    try {
      if (context.ddgBlocked) return { status: "skipped", reason: "provider blocked during current analysis", results: [], durationMs: 0 };
      const response = await provider(query);
      if (response.status === "blocked") context.ddgBlocked = true;
      return response;
    } finally { release(); }
  });
}
export function runDdgQueriesForAnalysis(queries: string[], provider: (query: string) => Promise<SearchResponse>) {
  const context = createSearchContext();
  return Promise.all(queries.map((query) => ddgForAnalysis(query, context, provider)));
}
function scoreResults(response: SearchResponse, business: Business): SearchResponse {
  return { ...response, results: response.results.map((result) => { const relevance = evaluateResultRelevance(result, business); return { ...result, accepted: relevance.accepted, relevanceScore: relevance.score, relevanceReason: relevance.reason }; }) };
}
async function searchBoth(query: string, business: Business, context = createSearchContext()) {
  const [ddgRaw, bingRaw] = await Promise.all([ddgForAnalysis(query, context), bingSearch(query)]);
  const ddg = scoreResults(ddgRaw, business); const bing = scoreResults(bingRaw, business);
  const seen = new Set<string>();
  return { ddg, bing, combined: [...ddg.results, ...bing.results].filter((item) => item.accepted).filter((item) => { const key = item.url || `${item.title}|${item.snippet}`; if (seen.has(key)) return false; seen.add(key); return true; }) };
}

export function planOwnerFallbackQueries(business: Business) {
  const location = [business.city, business.state].filter(Boolean).map((value) => `"${value}"`).join(" ");
  const category = business.category ? ` "${business.category}"` : "";
  return uniq([
    `"${business.name}" owner ${location}${category}`.replace(/\s+/g, " ").trim(),
    `"${business.name}" founder OR president${business.state ? ` "${business.state}"` : ""}`,
    `"${business.name}" "managing member"`,
  ]);
}

function strongWebCandidate(results: SearchResult[], business: Business) {
  for (const result of results) {
    if (!result.accepted || result.relevanceScore < 6) continue;
    const people = extractPeopleNearRoles(`${result.title}. ${result.snippet}`, business.name || "");
    if (people.some((person) => { const role = classifyRole(person.title); return role === "owner_relationship" || role === "decision_maker"; })) return true;
  }
  return false;
}

export function shouldDeepFetchOwnerResult(result: SearchResult, business: Business) {
  return result.accepted && result.relevanceScore >= 6 && isExternalSource(result.url)
    && extractPeopleNearRoles(`${result.title}. ${result.snippet}`, business.name || "").length === 0;
}
export function shouldRunContactEnrichment(candidateCount: number) { return candidateCount > 0; }

type WebFallbackOptions = {
  budgetMs?: number;
  ddgProvider?: (query: string) => Promise<SearchResponse>;
  bingProvider?: (query: string) => Promise<SearchResponse>;
  deepFetch?: (url: string, timeoutMs: number) => Promise<string>;
};

export async function runBoundedOwnerWebFallback(business: Business, options: WebFallbackOptions = {}) {
  const budgetMs = options.budgetMs || 5500;
  const queries = planOwnerFallbackQueries(business);
  const started = performance.now();
  const context = createSearchContext();
  const searched: Array<{ query: string; ddg: SearchResponse; bing: SearchResponse; combined: SearchResult[] }> = [];
  const debug: OwnerDebug["webFallback"] = { fallbackStarted: true, budgetMs, elapsedMs: 0, queriesPlanned: queries, queriesExecuted: [], queriesSkipped: [], ddgCalls: 0, bingCalls: 0, pagesFetched: 0, budgetExceeded: false };
  const ddgProvider = options.ddgProvider || duckDuckGoSearch;
  const bingProvider = options.bingProvider || bingSearch;
  const deepFetch = options.deepFetch || fetchVisible;
  for (const query of queries) {
    const remaining = budgetMs - (performance.now() - started);
    if (remaining <= 0) { debug.budgetExceeded = true; break; }
    debug.queriesExecuted.push(query);
    const ddgWillCall = !context.ddgBlocked; if (ddgWillCall) debug.ddgCalls += 1;
    debug.bingCalls += 1;
    let ddgValue: SearchResponse | undefined; let bingValue: SearchResponse | undefined;
    const ddgTask = ddgForAnalysis(query, context, ddgProvider).then((value) => { ddgValue = value; });
    const bingTask = bingProvider(query).then((value) => { bingValue = value; });
    const settled = await withTimeBudget(Promise.allSettled([ddgTask, bingTask]), Math.max(1, Math.floor(remaining)));
    const elapsed = Math.round(performance.now() - started);
    const timeoutResponse = (provider: string): SearchResponse => ({ status: "timeout", reason: `${provider} did not complete before the overall fallback budget.`, results: [], durationMs: elapsed });
    const ddg = scoreResults(ddgValue || timeoutResponse("DuckDuckGo"), business);
    const bing = scoreResults(bingValue || timeoutResponse("Bing"), business);
    const seen = new Set<string>();
    let combined = [...ddg.results, ...bing.results].filter((item) => item.accepted).filter((item) => { const key = item.url || `${item.title}|${item.snippet}`; if (seen.has(key)) return false; seen.add(key); return true; });
    if (!strongWebCandidate(combined, business) && debug.pagesFetched === 0) {
      const promising = combined.find((result) => shouldDeepFetchOwnerResult(result, business));
      const deepRemaining = budgetMs - (performance.now() - started);
      if (promising && deepRemaining > 250) {
        debug.pagesFetched += 1;
        const page = await withTimeBudget(deepFetch(promising.url, Math.min(1000, Math.floor(deepRemaining))), Math.min(1000, Math.floor(deepRemaining)));
        if (page.status === "completed" && page.value && extractPeopleNearRoles(page.value, business.name || "").length) combined = [...combined, { ...promising, snippet: page.value.slice(0, 4000) }];
      }
    }
    searched.push({ query, ddg, bing, combined });
    if (strongWebCandidate(combined, business)) { debug.earlyStopReason = "strong web owner/decision-maker candidate found"; break; }
    if (settled.status === "timeout" || performance.now() - started >= budgetMs) { debug.budgetExceeded = true; break; }
  }
  debug.queriesSkipped = queries.filter((query) => !debug.queriesExecuted.includes(query));
  debug.elapsedMs = Math.round(performance.now() - started);
  if (debug.budgetExceeded && !debug.earlyStopReason) debug.earlyStopReason = "overall web fallback budget exhausted";
  return { searched, debug };
}

export function determineOwnerDiscoveryMode(sources: SourceDebug[], business?: Business): OwnerDebug["ownerDiscoveryMode"] {
  const strong = sources.some((source) => source.companyMatches.some((match) => match.score >= 80)
    && source.people.some((person) => person.identityConfidence >= 85 && person.relationshipType !== "registered_agent" && person.relationshipType !== "unknown"));
  if (strong) return "registry_confirmed";
  if (sources.some((source) => /ambiguous/i.test(source.reason || "") || ("registryStatus" in source && source.registryStatus === "ambiguous"))) return "registry_ambiguous_web_fallback";
  const state = business ? detectState(business) : "";
  if ((business && !["CT", "NY"].includes(state)) || (!business && sources.length > 0 && sources.every((source) => !source.attempted))) return "unsupported_state_web_fallback";
  return "registry_no_match_web_fallback";
}

export async function withTimeBudget<T>(promise: Promise<T>, budgetMs: number): Promise<{ status: "completed"; value: T } | { status: "timeout" }> {
  return Promise.race([promise.then((value) => ({ status: "completed" as const, value })), new Promise<{ status: "timeout" }>((resolve) => setTimeout(() => resolve({ status: "timeout" }), budgetMs))]);
}

async function fetchVisible(url: string, timeoutMs = 4000) {
  try {
    const r = await fetch(url, { redirect: "follow", cache: "no-store", signal: AbortSignal.timeout(timeoutMs), headers });
    if (!r.ok) return "";
    const $ = cheerio.load(await r.text()); $("script,style,noscript,svg").remove();
    return $("body").text().replace(/\s+/g, " ").trim();
  } catch { return ""; }
}

export async function findOwnerCandidatesWithDebug(business: Business): Promise<{ ownerCandidates: OwnerCandidate[]; debug: OwnerDebug; businessContacts: BusinessContacts }> {
  const totalStarted = performance.now();
  const debug: OwnerDebug = { sources: [], contactEnrichment: [], ownerDiscoveryMode: "registry_no_match_web_fallback", timing: [], queries: [], webFallback: { fallbackStarted: false, budgetMs: 5500, elapsedMs: 0, queriesPlanned: [], queriesExecuted: [], queriesSkipped: [], ddgCalls: 0, bingCalls: 0, pagesFetched: 0, budgetExceeded: false } };
  const businessContacts: BusinessContacts = { phones: [], emails: [] };
  if (!business.name) return { ownerCandidates: [], debug, businessContacts };

  const queries = planOwnerFallbackQueries(business);

  const registryStarted = performance.now();
  const directSources = await searchStateRegistries(business);
  debug.timing.push({ stage: "state_registry", status: "completed", durationMs: Math.round(performance.now() - registryStarted) });
  debug.ownerDiscoveryMode = determineOwnerDiscoveryMode(directSources, business);
  const searchContext = createSearchContext();
  let searched: Array<{ query: string; ddg: SearchResponse; bing: SearchResponse; combined: SearchResult[] }>;
  if (debug.ownerDiscoveryMode === "registry_confirmed") {
    const skip = (): SearchResponse => ({ status: "skipped", reason: "skipped: strong official registry evidence already available", results: [], durationMs: 0 });
    searched = uniq(queries).map((query) => ({ query, ddg: skip(), bing: skip(), combined: [] }));
    debug.webFallback = { ...debug.webFallback, queriesPlanned: queries, queriesSkipped: queries, earlyStopReason: "strong official registry evidence already available" };
    debug.timing.push({ stage: "owner_web_search", status: "skipped", durationMs: 0, reason: "strong official registry evidence already available" });
  } else {
    const ownerSearchStarted = performance.now();
    const fallback = await runBoundedOwnerWebFallback(business, { budgetMs: 5500 });
    searched = fallback.searched; debug.webFallback = fallback.debug;
    const fallbackStatus = fallback.debug.budgetExceeded ? (searched.length ? "partial" : "timeout") : "completed";
    debug.timing.push({ stage: "owner_web_search", status: fallbackStatus, durationMs: Math.round(performance.now() - ownerSearchStarted), reason: fallback.debug.earlyStopReason });
  }
  debug.sources = directSources;
  const candidates = new Map<string, OwnerCandidate>();

  for (const sourceDebug of directSources) {
    for (const person of sourceDebug.people) {
      const key = ownerPersonKey(person.name);
      const source: OwnerEvidenceSource = { label: `${person.sourceName}: ${person.role}`, url: person.sourceUrl, snippet: person.evidenceText, phones: [], emails: [], sourceName: person.sourceName, evidenceText: person.evidenceText, companyMatchEvidence: person.companyMatchEvidence, relationshipType: person.relationshipType };
      const existing = candidates.get(key);
      if (existing) {
        if (!existing.sources.some((item) => item.url === source.url && item.label === source.label)) existing.sources.push(source);
        existing.confidence = Math.max(existing.confidence, person.identityConfidence);
        if (person.relationshipType === "owner_relationship") existing.relationshipType = person.relationshipType;
      } else {
        candidates.set(key, { name: person.name, title: person.role, relationshipType: person.relationshipType, confidence: person.identityConfidence, phones: [], emails: [], contacts: [], sources: [source] });
      }
    }
  }

  for (const entry of searched) {
    const allResults = [...entry.ddg.results, ...entry.bing.results];
    const debugResults = allResults.map((result) => ({ engine: result.engine, title: result.title, url: result.url, originalUrl: result.originalUrl, snippet: result.snippet, accepted: result.accepted, relevanceScore: result.relevanceScore, relevanceReason: result.relevanceReason, extracted: result.accepted ? extractPeopleNearRoles(`${result.title}. ${result.snippet}`, business.name!) : [] }));
    const providerDebug = (response: SearchResponse): ProviderDebug => ({ status: response.status, httpStatus: response.httpStatus, parsedCount: response.results.length, acceptedCount: response.results.filter((r) => r.accepted).length, rejectedCount: response.results.filter((r) => !r.accepted).length, reason: response.reason, durationMs: response.durationMs });
    debug.queries.push({ query: entry.query, duckduckgo: providerDebug(entry.ddg), bing: providerDebug(entry.bing), results: debugResults });

    for (const result of entry.combined) {
      const text = `${result.title}. ${result.snippet}`;
      if (isExternalSource(result.url) && normalize(text).includes(normalize(business.name))) {
        businessContacts.phones = uniq([...businessContacts.phones, ...extractPhones(text)]);
        businessContacts.emails = uniq([...businessContacts.emails, ...extractEmails(text)]);
      }
      for (const person of extractPeopleNearRoles(text, business.name)) {
        const key = ownerPersonKey(person.name);
        const relationshipType = classifyRole(person.title);
        const source: OwnerEvidenceSource = { label: result.title, url: result.url, snippet: result.snippet, phones: [], emails: [], relationshipType };
        const existing = candidates.get(key);
        if (existing) {
          if (!existing.sources.some((s) => s.url === source.url)) existing.sources.push(source);
          existing.confidence = Math.min(98, existing.confidence + 16);
        } else {
          let confidence = 64;
          if (isExternalSource(result.url)) confidence += 8;
          if (normalize(text).includes(normalize(business.name))) confidence += 8;
          candidates.set(key, { name: person.name, title: person.title, relationshipType, confidence, phones: [], emails: [], contacts: [], sources: [source] });
        }
      }
    }
  }

  const mergeStarted = performance.now();
  const ranked = [...candidates.values()].sort((a, b) => b.confidence - a.confidence || b.sources.length - a.sources.length).slice(0, 5);
  debug.timing.push({ stage: "owner_merge", status: "completed", durationMs: Math.round(performance.now() - mergeStarted) });

  if (!shouldRunContactEnrichment(ranked.length)) {
    debug.timing.push({ stage: "contact_enrichment", status: "skipped", durationMs: 0, reason: "no person candidate found" });
    debug.timing.push({ stage: "owners_total", status: "completed", durationMs: Math.round(performance.now() - totalStarted) });
    return { ownerCandidates: ranked, debug, businessContacts };
  }

  const contactStarted = performance.now();
  const completedContactTasks: Array<{ candidate: OwnerCandidate; contacts: OwnerContact[]; debugEntry?: OwnerDebug["contactEnrichment"][number] }> = [];
  const contactTasks: Promise<void>[] = [];
  const fmcsaTasks: Promise<void>[] = [];
  const publicDocumentTasks: Promise<void>[] = [];
  let publicDocumentChain = Promise.resolve();
  let publicDocumentStrongMatch = false;
  const fmcsaCompleted = new Set<string>();
  const publicDocumentCompleted = new Set<string>();
  for (const candidate of ranked) {
    const knownBusinessPhones = uniq([...(business.phone ? [business.phone] : []), ...businessContacts.phones]);
    for (const source of candidate.sources.slice(0, 3)) candidate.contacts.push(...extractOwnerContactEvidence(`${source.label}. ${source.snippet || ""}`, candidate.name, business.name!, source.url, knownBusinessPhones));
    contactTasks.push(searchProfessionalContactSources(candidate.name, business).then((professionalSources) => {
      const contacts: OwnerContact[] = [];
      for (const source of professionalSources) for (const raw of source.candidatesFound) {
        const contact = classifyOwnerContact({ value: raw.value, kind: raw.kind, sourceUrl: raw.sourceUrl, evidenceText: raw.evidenceText, ownerName: candidate.name, businessName: business.name!, businessPhones: uniq([...knownBusinessPhones, ...(raw.relatedBusinessPhones || [])]), sourceName: raw.sourceName });
        contacts.push(contact); source.acceptedCandidates.push({ ...raw, contactType: contact.contactType, confidence: contact.confidence, reason: contact.reason });
        source.classificationReason = contact.reason;
      }
      completedContactTasks.push({ candidate, contacts, debugEntry: { personName: candidate.name, companyName: business.name!, sources: professionalSources } });
    }));
    if (shouldRunFmcsaContact(business)) {
      const fmcsaStarted = performance.now();
      fmcsaTasks.push(searchFmcsaContact(candidate.name, business).then((source) => {
        source.durationMs = Math.round(performance.now() - fmcsaStarted);
        const contacts: OwnerContact[] = [];
        for (const raw of source.candidatesFound) {
          const contact = classifyOwnerContact({ value: raw.value, kind: raw.kind, sourceUrl: raw.sourceUrl, evidenceText: raw.evidenceText, ownerName: candidate.name, businessName: business.name!, businessPhones: uniq([...knownBusinessPhones, ...(raw.relatedBusinessPhones || [])]), sourceName: raw.sourceName });
          contacts.push(contact); source.acceptedCandidates.push({ ...raw, contactType: contact.contactType, confidence: contact.confidence, reason: contact.reason }); source.classificationReason = contact.reason;
        }
        fmcsaCompleted.add(ownerPersonKey(candidate.name));
        completedContactTasks.push({ candidate, contacts, debugEntry: { personName: candidate.name, companyName: business.name!, sources: [source] } });
      }).catch((error) => {
        const source: ContactSourceDebug = { sourceName: "FMCSA CONTACT ENRICHMENT", attempted: true, input: `${candidate.name} | ${business.name || ""} | ${business.address || ""}`, status: "error", candidatesFound: [], acceptedCandidates: [], rejectedCandidates: [], durationMs: Math.round(performance.now() - fmcsaStarted), reason: error instanceof Error ? error.message : "FMCSA enrichment failed" };
        fmcsaCompleted.add(ownerPersonKey(candidate.name));
        completedContactTasks.push({ candidate, contacts: [], debugEntry: { personName: candidate.name, companyName: business.name!, sources: [source] } });
      }));
    }
    const publicDocumentStarted = performance.now();
    const publicDocumentTask = publicDocumentChain.then(() => publicDocumentStrongMatch
      ? ({ sourceName: "PUBLIC DOCUMENT CONTACT ENRICHMENT", attempted: false, input: `${candidate.name} | ${business.name || ""} | ${business.address || ""}`, status: "skipped", candidatesFound: [], acceptedCandidates: [], rejectedCandidates: [], reason: "Skipped after an earlier confirmed owner produced a strong structured public-document contact match." } as ContactSourceDebug)
      : searchPublicDocumentContact(candidate.name, business)).then((source) => {
      source.durationMs = Math.round(performance.now() - publicDocumentStarted);
      const contacts: OwnerContact[] = [];
      for (const raw of source.candidatesFound) {
        const contact = classifyOwnerContact({ value: raw.value, kind: raw.kind, sourceUrl: raw.sourceUrl, evidenceText: raw.evidenceText, ownerName: candidate.name, businessName: business.name!, businessPhones: uniq([...knownBusinessPhones, ...(raw.relatedBusinessPhones || [])]), sourceName: raw.sourceName });
        contacts.push(contact); source.acceptedCandidates.push({ ...raw, contactType: contact.contactType, confidence: contact.confidence, reason: contact.reason }); source.classificationReason = contact.reason;
      }
      if (source.status === "matched" && contacts.some((contact) => contact.contactType === "verified_direct" || contact.contactType === "possible_direct")) publicDocumentStrongMatch = true;
      publicDocumentCompleted.add(ownerPersonKey(candidate.name));
      completedContactTasks.push({ candidate, contacts, debugEntry: { personName: candidate.name, companyName: business.name!, sources: [source] } });
    }).catch((error) => {
      const source: ContactSourceDebug = { sourceName: "PUBLIC DOCUMENT CONTACT ENRICHMENT", attempted: true, input: `${candidate.name} | ${business.name || ""} | ${business.address || ""}`, status: "error", candidatesFound: [], acceptedCandidates: [], rejectedCandidates: [], durationMs: Math.round(performance.now() - publicDocumentStarted), reason: error instanceof Error ? error.message : "Public-document enrichment failed" };
      publicDocumentCompleted.add(ownerPersonKey(candidate.name));
      completedContactTasks.push({ candidate, contacts: [], debugEntry: { personName: candidate.name, companyName: business.name!, sources: [source] } });
    });
    publicDocumentChain = publicDocumentTask.catch(() => undefined);
    publicDocumentTasks.push(publicDocumentTask);
    const directQueries = [
      `"${candidate.name}" "${business.name}" phone`,
      `"${candidate.name}" "${business.name}" email`,
      `site:einpresswire.com "${candidate.name}" "${business.name}"`,
      `site:prnewswire.com "${candidate.name}" "${business.name}"`,
      `site:prweb.com "${candidate.name}" "${business.name}"`,
    ];
    contactTasks.push(Promise.all(directQueries.map((query) => searchBoth(query, business, searchContext))).then(async (directSearches) => {
      const contacts: OwnerContact[] = [];
      const directResults = directSearches.flatMap((item) => item.combined).filter((result) => isExternalSource(result.url));
      await Promise.all(directResults.slice(0, 10).map(async (result) => {
        const snippetText = `${result.title}. ${result.snippet}`;
        const snippetContacts = extractOwnerContactEvidence(snippetText, candidate.name, business.name!, result.url, knownBusinessPhones);
        let pageContacts: OwnerContact[] = [];
        if (!snippetContacts.some((contact) => contact.contactType === "verified_direct")) { const visible = await fetchVisible(result.url); if (visible) pageContacts = extractOwnerContactEvidence(visible, candidate.name, business.name!, result.url, knownBusinessPhones); }
        contacts.push(...snippetContacts, ...pageContacts);
      }));
      completedContactTasks.push({ candidate, contacts });
    }));
  }
  const contactBudgetMs = 2500;
  const fmcsaBudgetMs = 30000;
  const publicDocumentBudgetMs = 15000;
  const [contactBudget, fmcsaBudget, publicDocumentBudget] = await Promise.all([withTimeBudget(Promise.all(contactTasks), contactBudgetMs), withTimeBudget(Promise.all(fmcsaTasks), fmcsaBudgetMs), withTimeBudget(Promise.all(publicDocumentTasks), publicDocumentBudgetMs)]);
  if (fmcsaBudget.status === "timeout") for (const candidate of ranked) if (shouldRunFmcsaContact(business) && !fmcsaCompleted.has(ownerPersonKey(candidate.name))) {
    const source: ContactSourceDebug = { sourceName: "FMCSA CONTACT ENRICHMENT", attempted: true, input: `${candidate.name} | ${business.name || ""} | ${business.address || ""}`, status: "timeout", candidatesFound: [], acceptedCandidates: [], rejectedCandidates: [], durationMs: fmcsaBudgetMs, reason: `FMCSA enrichment did not complete within its dedicated ${fmcsaBudgetMs}ms budget; owner result preserved.` };
    completedContactTasks.push({ candidate, contacts: [], debugEntry: { personName: candidate.name, companyName: business.name!, sources: [source] } });
  }
  if (publicDocumentBudget.status === "timeout") for (const candidate of ranked) if (!publicDocumentCompleted.has(ownerPersonKey(candidate.name))) {
    const source: ContactSourceDebug = { sourceName: "PUBLIC DOCUMENT CONTACT ENRICHMENT", attempted: true, input: `${candidate.name} | ${business.name || ""} | ${business.address || ""}`, status: "timeout", candidatesFound: [], acceptedCandidates: [], rejectedCandidates: [], durationMs: publicDocumentBudgetMs, reason: `Public-document enrichment did not complete within its dedicated ${publicDocumentBudgetMs}ms budget; owner result preserved.` };
    completedContactTasks.push({ candidate, contacts: [], debugEntry: { personName: candidate.name, companyName: business.name!, sources: [source] } });
  }
  for (const result of completedContactTasks) { result.candidate.contacts.push(...result.contacts); if (result.debugEntry) debug.contactEnrichment.push(result.debugEntry); }
  for (const candidate of ranked) {
    const contactSeen = new Set<string>();
    candidate.contacts = candidate.contacts.filter((contact) => {
      const key = `${contact.kind}|${contact.kind === "phone" ? normalizePhone(contact.value) : contact.value.toLowerCase()}|${contact.sourceUrl}|${contact.contactType}`;
      if (contactSeen.has(key)) return false; contactSeen.add(key); return true;
    });
    candidate.phones = uniq(candidate.contacts.filter((c) => c.kind === "phone" && c.contactType === "verified_direct").map((c) => c.value));
    candidate.emails = uniq(candidate.contacts.filter((c) => c.kind === "email" && c.contactType === "verified_direct").map((c) => c.value));
  }
  const contactStatus = contactBudget.status === "completed" ? "completed" : completedContactTasks.length ? "partial" : "timeout";
  debug.timing.push({ stage: "contact_enrichment", status: contactStatus, durationMs: Math.round(performance.now() - contactStarted), reason: contactBudget.status === "timeout" ? `overall contact enrichment budget of ${contactBudgetMs}ms reached; owner result preserved` : undefined });
  if (fmcsaTasks.length) debug.timing.push({ stage: "fmcsa_contact_enrichment", status: fmcsaBudget.status === "completed" ? "completed" : "timeout", durationMs: Math.min(fmcsaBudgetMs, Math.round(performance.now() - contactStarted)), reason: fmcsaBudget.status === "timeout" ? `dedicated FMCSA budget of ${fmcsaBudgetMs}ms reached; owner result preserved` : undefined });
  debug.timing.push({ stage: "public_document_contact_enrichment", status: publicDocumentBudget.status === "completed" ? "completed" : "timeout", durationMs: Math.min(publicDocumentBudgetMs, Math.round(performance.now() - contactStarted)), reason: publicDocumentBudget.status === "timeout" ? `dedicated public-document budget of ${publicDocumentBudgetMs}ms reached; owner result preserved` : undefined });
  debug.timing.push({ stage: "owners_total", status: "completed", durationMs: Math.round(performance.now() - totalStarted) });

  return { ownerCandidates: ranked, debug, businessContacts };
}

export async function findOwnerCandidates(business: Business) { return (await findOwnerCandidatesWithDebug(business)).ownerCandidates; }
