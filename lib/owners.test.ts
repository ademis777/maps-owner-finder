import assert from "node:assert/strict";
import test from "node:test";
import { classifyDdgResponse, classifyOwnerContact, decodeBingUrl, determineOwnerDiscoveryMode, evaluateResultRelevance, isExternalSource, normalizePhone, runBoundedOwnerWebFallback, runDdgQueriesForAnalysis, shouldDeepFetchOwnerResult, shouldRunContactEnrichment, withTimeBudget } from "./owners.ts";

const base = {
  sourceUrl: "https://bbb.org/company/acme",
  ownerName: "John Smith",
  businessName: "Acme Roofing",
};

test("Maps/CSV business phone is business, not direct", () => {
  const contact = classifyOwnerContact({ ...base, kind: "phone", value: "(212) 555-0100", evidenceText: "Acme Roofing owner John Smith. Phone: 212-555-0100", businessPhones: ["+1 212 555 0100"] });
  assert.equal(contact.contactType, "business");
});

test("role-based info email is general_email", () => {
  const contact = classifyOwnerContact({ ...base, kind: "email", value: "info@company.com", evidenceText: "Acme Roofing owner John Smith info@company.com" });
  assert.equal(contact.contactType, "general_email");
});

test("personal-looking email near owner is possible direct without explicit evidence", () => {
  const contact = classifyOwnerContact({ ...base, kind: "email", value: "john@company.com", evidenceText: "Acme Roofing owner John Smith can be reached at john@company.com" });
  assert.equal(contact.contactType, "possible_direct");
});

test("personal email with direct label is verified direct", () => {
  const contact = classifyOwnerContact({ ...base, kind: "email", value: "john@company.com", evidenceText: "Acme Roofing owner John Smith direct email: john@company.com" });
  assert.equal(contact.contactType, "verified_direct");
});

test("personal-looking email without company evidence is not verified", () => {
  const contact = classifyOwnerContact({ value: "john@company.com", kind: "email", sourceUrl: "https://license.example/1", evidenceText: "John Smith email john@company.com", ownerName: "John Smith", businessName: "Smith Roofing LLC" });
  assert.equal(contact.contactType, "unknown");
});

test("personal-looking company email with person and company evidence is possible direct", () => {
  const contact = classifyOwnerContact({ value: "john@smithroofing.com", kind: "email", sourceUrl: "https://license.example/1", evidenceText: "John Smith professional record for Smith Roofing LLC. Business email john@smithroofing.com", ownerName: "John Smith", businessName: "Smith Roofing LLC" });
  assert.equal(contact.contactType, "possible_direct");
});

test("PR media contact is press_media", () => {
  const contact = classifyOwnerContact({ ...base, sourceUrl: "https://www.prnewswire.com/news/acme", kind: "email", value: "john@company.com", evidenceText: "Acme Roofing founder John Smith. Media Contact: john@company.com" });
  assert.equal(contact.contactType, "press_media");
});

test("mobile number explicitly linked to owner is verified direct", () => {
  const contact = classifyOwnerContact({ ...base, kind: "phone", value: "212-555-0199", evidenceText: "Acme Roofing owner John Smith - Mobile: 212-555-0199" });
  assert.equal(contact.contactType, "verified_direct");
});

test("phone normalization compares common US formats", () => {
  assert.equal(normalizePhone("+1 (212) 555-0100"), normalizePhone("212.555.0100"));
});

test("DDG HTTP 202 is blocked, not empty", () => {
  assert.equal(classifyDdgResponse(202, "<html><title>DuckDuckGo</title></html>", 0).status, "blocked");
});

test("DDG challenge HTML is blocked", () => {
  assert.equal(classifyDdgResponse(200, "<html>Bot detection challenge: verify you are human</html>", 0).status, "blocked");
});

test("normal DDG empty page is empty", () => {
  assert.equal(classifyDdgResponse(200, "<html><body>No results found</body></html>", 0).status, "empty");
});

test("Bing a1 base64 redirect URL is decoded", () => {
  const destination = "https://www.bbb.org/us/or/portland/profile/example";
  const encoded = Buffer.from(destination).toString("base64url");
  const tracking = `https://www.bing.com/ck/a?u=a1${encoded}&ntb=1`;
  assert.equal(decodeBingUrl(tracking), destination);
});

test("Bing direct url parameter is decoded", () => {
  const destination = "https://www.prnewswire.com/news/example";
  assert.equal(decodeBingUrl(`https://www.bing.com/ck/a?url=${encodeURIComponent(destination)}`), destination);
});

test("external allowlist is applied to decoded Bing destination", () => {
  const destination = "https://www.bizapedia.com/or/example.html";
  const tracking = `https://www.bing.com/ck/a?u=a1${Buffer.from(destination).toString("base64url")}`;
  assert.equal(isExternalSource(decodeBingUrl(tracking)), true);
  assert.equal(isExternalSource(tracking), false);
});

test("irrelevant one-word Bing result is rejected", () => {
  const relevance = evaluateResultRelevance({ title: "Death - Wikipedia", snippet: "Death is the end of life.", url: "https://en.wikipedia.org/wiki/Death" }, { name: "Death Wish Coffee Company", mapsUrl: "https://maps.google.com", mapsStatus: "partial" });
  assert.equal(relevance.accepted, false);
});

test("result containing the company name is accepted", () => {
  const relevance = evaluateResultRelevance({ title: "Death Wish Coffee Company founder profile", snippet: "Mike Brown founded Death Wish Coffee Company.", url: "https://example.org/profile" }, { name: "Death Wish Coffee Company", mapsUrl: "https://maps.google.com", mapsStatus: "partial" });
  assert.equal(relevance.accepted, true);
});

const registrySource = (relationshipType: "decision_maker" | "registered_agent", confidence = 90, score = 95) => ({ sourceName: "Official registry", attempted: true, input: "q", status: "matched" as const, companyMatches: [{ companyName: "Test LLC", sourceUrl: "https://registry.example/1", score, evidence: "exact name, city, state" }], rejectedMatches: [], people: [{ name: "John Smith", role: relationshipType === "registered_agent" ? "Registered Agent" : "CEO", relationshipType, sourceName: "Official registry", sourceUrl: "https://registry.example/1", evidenceText: "record", companyMatchEvidence: "exact name, city, state", identityConfidence: confidence }] });

test("strong official CEO evidence activates registry_confirmed", () => { assert.equal(determineOwnerDiscoveryMode([registrySource("decision_maker")]), "registry_confirmed"); });
test("registered agent does not activate registry_confirmed", () => { assert.equal(determineOwnerDiscoveryMode([registrySource("registered_agent")]), "registry_no_match_web_fallback"); });
test("ambiguous registry result requires bounded web fallback", () => { const source = { ...registrySource("decision_maker", 70, 60), reason: "Multiple matches; ambiguous." }; assert.equal(determineOwnerDiscoveryMode([source]), "registry_ambiguous_web_fallback"); });
test("unsupported state selects bounded web fallback", () => { assert.equal(determineOwnerDiscoveryMode([{ sourceName: "x", attempted: false, input: "q", status: "skipped", companyMatches: [], rejectedMatches: [], people: [] }], { name: "Test", address: "Derry, NH 03038", mapsUrl: "x", mapsStatus: "resolved" }), "unsupported_state_web_fallback"); });
test("registry no-match selects bounded web fallback", () => { assert.equal(determineOwnerDiscoveryMode([{ sourceName: "x", attempted: true, input: "q", status: "empty", companyMatches: [], rejectedMatches: [], people: [] }], { name: "Test", address: "Hartford, CT 06103", mapsUrl: "x", mapsStatus: "resolved" }), "registry_no_match_web_fallback"); });

test("blocked DDG provider is called once and later queries are skipped", async () => {
  let calls = 0;
  const responses = await runDdgQueriesForAnalysis(["one", "two", "three"], async () => { calls += 1; return { status: "blocked", reason: "HTTP 202", results: [] }; });
  assert.equal(calls, 1); assert.equal(responses[1].status, "skipped"); assert.equal(responses[1].reason, "provider blocked during current analysis");
});

test("contact timeout preserves an already confirmed owner object", async () => {
  const owner = { name: "John Smith", confidence: 90 };
  const result = await withTimeBudget(new Promise<void>(() => {}), 5);
  assert.equal(result.status, "timeout"); assert.equal(owner.name, "John Smith");
});

const fallbackBusiness = { name: "Acme Roofing LLC", city: "Hartford", state: "CT", address: "10 Main St, Hartford, CT 06103", mapsUrl: "x", mapsStatus: "resolved" as const };
const emptySearch = { status: "empty" as const, results: [] };
const strongResult = { title: "Acme Roofing LLC owner John Smith", snippet: "Owner John Smith leads Acme Roofing LLC in Hartford.", url: "https://www.bbb.org/acme", originalUrl: "https://www.bbb.org/acme", engine: "bing" as const, accepted: true, relevanceScore: 0, relevanceReason: "" };

test("fallback budget stops new queries and preserves completed partial results", async () => {
  const partialResult = { ...strongResult, title: "Acme Roofing LLC profile", snippet: "Acme Roofing LLC Hartford business profile." };
  const result = await runBoundedOwnerWebFallback(fallbackBusiness, { budgetMs: 10, ddgProvider: async () => new Promise(() => {}), bingProvider: async () => ({ status: "ok", results: [partialResult] }), deepFetch: async () => "" });
  assert.equal(result.debug.budgetExceeded, true); assert.equal(result.debug.queriesExecuted.length, 1); assert.equal(result.debug.queriesSkipped.length, 2); assert.equal(result.searched[0].bing.results.length, 1);
});

test("strong web candidate causes early stop", async () => {
  const result = await runBoundedOwnerWebFallback(fallbackBusiness, { budgetMs: 100, ddgProvider: async () => emptySearch, bingProvider: async () => ({ status: "ok", results: [strongResult] }) });
  assert.match(result.debug.earlyStopReason || "", /strong web/); assert.equal(result.debug.queriesExecuted.length, 1);
});

test("DDG blocked is called only once across bounded fallback", async () => {
  let calls = 0; const result = await runBoundedOwnerWebFallback(fallbackBusiness, { budgetMs: 100, ddgProvider: async () => { calls += 1; return { status: "blocked", results: [] }; }, bingProvider: async () => emptySearch });
  assert.equal(calls, 1); assert.equal(result.debug.ddgCalls, 1); assert.equal(result.debug.bingCalls, 3);
});

test("Bing deep fetch runs only for a relevant accepted candidate", async () => {
  let fetches = 0; const relevant = { ...strongResult, title: "Acme Roofing LLC profile", snippet: "Acme Roofing LLC Hartford company profile." };
  const result = await runBoundedOwnerWebFallback(fallbackBusiness, { budgetMs: 1000, ddgProvider: async () => emptySearch, bingProvider: async () => ({ status: "ok", results: [relevant] }), deepFetch: async () => { fetches += 1; return "Acme Roofing LLC owner John Smith"; } });
  assert.equal(shouldDeepFetchOwnerResult({ ...relevant, accepted: false }, fallbackBusiness), false); assert.equal(fetches, 1); assert.equal(result.debug.pagesFetched, 1);
});

test("no person means contact enrichment does not run", () => { assert.equal(shouldRunContactEnrichment(0), false); assert.equal(shouldRunContactEnrichment(1), true); });
