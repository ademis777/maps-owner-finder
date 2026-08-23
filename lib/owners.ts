import * as cheerio from "cheerio";
import type { Business } from "./maps";

export type OwnerCandidate = {
  name: string;
  title?: string;
  confidence: number;
  phones: string[];
  emails: string[];
  sources: Array<{ label: string; url: string; snippet?: string; phones?: string[]; emails?: string[] }>;
};

export type OwnerDebug = {
  queries: Array<{
    query: string;
    duckduckgoCount: number;
    bingCount: number;
    results: Array<{
      engine: "duckduckgo" | "bing";
      title: string;
      url: string;
      snippet: string;
      extracted: Array<{ name: string; title: string }>;
    }>;
  }>;
};

export type BusinessContacts = { phones: string[]; emails: string[] };
type SearchResult = { title: string; url: string; snippet: string; engine: "duckduckgo" | "bing" };

const rolePattern = /(owner|founder|co-founder|president|ceo|managing member|member|principal|proprietor)/i;
const roleExpr = `[Oo]wner|[Ff]ounder|[Cc]o-[Ff]ounder|[Pp]resident|CEO|[Mm]anaging [Mm]ember|[Mm]ember|[Pp]rincipal|[Pp]roprietor`;
const nameWord = `[A-Z][a-zA-Z'-]*`;
const personName = `${nameWord}(?:\\s+${nameWord}){1,2}`;
const blockedWords = new Set(["because","for","and","the","with","from","at","of","in","to","by","is","as","a","an","principal","contacts","customer","business","management","registered","agent","company","service","services"]);
const externalDomains = ["bbb.org","bizapedia.com","opencorporates.com","linkedin.com","manta.com","chamberofcommerce.com","datanyze.com","crunchbase.com","einpresswire.com","prweb.com","prnewswire.com"];

function normalize(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
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

function extractOwnerContactsStrict(text: string, ownerName: string, businessName: string) {
  const businessNeedle = normalize(businessName);
  const valid = chunksAround(text, ownerName, 240).filter((chunk) => normalize(chunk).includes(businessNeedle));
  return { phones: uniq(valid.flatMap(extractPhones)), emails: uniq(valid.flatMap(extractEmails)) };
}

function isExternalSource(url: string) {
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

function parseDdgHtml(html: string): SearchResult[] {
  const $ = cheerio.load(html); const results: SearchResult[] = [];
  $(".result").slice(0, 10).each((_, element) => {
    const title = $(element).find(".result__a").text().trim();
    const href = $(element).find(".result__a").attr("href") || "";
    const snippet = $(element).find(".result__snippet").text().replace(/\s+/g, " ").trim();
    if (title && href) results.push({ title, url: decodeDuckDuckGoUrl(href), snippet, engine: "duckduckgo" });
  }); return results;
}
function parseDdgLite(html: string): SearchResult[] {
  const $ = cheerio.load(html); const results: SearchResult[] = [];
  $("a.result-link").slice(0, 10).each((_, element) => {
    const title = $(element).text().trim(); const href = $(element).attr("href") || "";
    const snippet = $(element).closest("tr").next().text().replace(/\s+/g, " ").trim();
    if (title && href) results.push({ title, url: decodeDuckDuckGoUrl(href), snippet, engine: "duckduckgo" });
  }); return results;
}
function parseBingHtml(html: string): SearchResult[] {
  const $ = cheerio.load(html); const results: SearchResult[] = [];
  $("li.b_algo").slice(0, 10).each((_, element) => {
    const link = $(element).find("h2 a").first(); const title = link.text().trim(); const href = link.attr("href") || "";
    const snippet = $(element).find(".b_caption p, p").first().text().replace(/\s+/g, " ").trim();
    if (title && href) results.push({ title, url: href, snippet, engine: "bing" });
  }); return results;
}

const headers = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36", "accept-language": "en-US,en;q=0.9" };
async function duckDuckGoSearch(query: string) {
  try { const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { cache: "no-store", signal: AbortSignal.timeout(4500), headers }); if (r.ok) { const parsed = parseDdgHtml(await r.text()); if (parsed.length) return parsed; } } catch {}
  try { const r = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, { cache: "no-store", signal: AbortSignal.timeout(3500), headers }); if (r.ok) return parseDdgLite(await r.text()); } catch {}
  return [];
}
async function bingSearch(query: string) {
  try { const r = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en-US`, { cache: "no-store", signal: AbortSignal.timeout(4500), headers }); if (r.ok) return parseBingHtml(await r.text()); } catch {}
  return [];
}
async function searchBoth(query: string) {
  const [ddg, bing] = await Promise.all([duckDuckGoSearch(query), bingSearch(query)]);
  const seen = new Set<string>();
  return { ddg, bing, combined: [...ddg, ...bing].filter((item) => { const key = item.url || `${item.title}|${item.snippet}`; if (seen.has(key)) return false; seen.add(key); return true; }) };
}

async function fetchVisible(url: string) {
  try {
    const r = await fetch(url, { redirect: "follow", cache: "no-store", signal: AbortSignal.timeout(4000), headers });
    if (!r.ok) return "";
    const $ = cheerio.load(await r.text()); $("script,style,noscript,svg").remove();
    return $("body").text().replace(/\s+/g, " ").trim();
  } catch { return ""; }
}

export async function findOwnerCandidatesWithDebug(business: Business): Promise<{ ownerCandidates: OwnerCandidate[]; debug: OwnerDebug; businessContacts: BusinessContacts }> {
  const debug: OwnerDebug = { queries: [] };
  const businessContacts: BusinessContacts = { phones: [], emails: [] };
  if (!business.name) return { ownerCandidates: [], debug, businessContacts };

  const queries = [
    `"${business.name}" owner`,
    `"${business.name}" president`,
    `site:bbb.org "${business.name}"`,
    `site:bizapedia.com "${business.name}"`,
  ];

  const searched = await Promise.all(queries.map(async (query) => ({ query, ...(await searchBoth(query)) })));
  const candidates = new Map<string, OwnerCandidate>();

  for (const entry of searched) {
    const debugResults = entry.combined.map((result) => ({ engine: result.engine, title: result.title, url: result.url, snippet: result.snippet, extracted: extractPeopleNearRoles(`${result.title}. ${result.snippet}`, business.name!) }));
    debug.queries.push({ query: entry.query, duckduckgoCount: entry.ddg.length, bingCount: entry.bing.length, results: debugResults });

    for (const result of entry.combined) {
      const text = `${result.title}. ${result.snippet}`;
      if (isExternalSource(result.url) && normalize(text).includes(normalize(business.name))) {
        businessContacts.phones = uniq([...businessContacts.phones, ...extractPhones(text)]);
        businessContacts.emails = uniq([...businessContacts.emails, ...extractEmails(text)]);
      }
      for (const person of extractPeopleNearRoles(text, business.name)) {
        const key = normalize(person.name);
        const source = { label: result.title, url: result.url, snippet: result.snippet, phones: [] as string[], emails: [] as string[] };
        const existing = candidates.get(key);
        if (existing) {
          if (!existing.sources.some((s) => s.url === source.url)) existing.sources.push(source);
          existing.confidence = Math.min(98, existing.confidence + 16);
        } else {
          let confidence = 64;
          if (isExternalSource(result.url)) confidence += 8;
          if (normalize(text).includes(normalize(business.name))) confidence += 8;
          candidates.set(key, { name: person.name, title: person.title, confidence, phones: [], emails: [], sources: [source] });
        }
      }
    }
  }

  const ranked = [...candidates.values()].sort((a, b) => b.confidence - a.confidence || b.sources.length - a.sources.length).slice(0, 5);

  await Promise.all(ranked.map(async (candidate) => {
    const directQueries = [
      `"${candidate.name}" "${business.name}" phone`,
      `"${candidate.name}" "${business.name}" email`,
      `site:einpresswire.com "${candidate.name}" "${business.name}"`,
      `site:prnewswire.com "${candidate.name}" "${business.name}"`,
      `site:prweb.com "${candidate.name}" "${business.name}"`,
    ];
    const directSearches = await Promise.all(directQueries.map(searchBoth));
    const directResults = directSearches.flatMap((item) => item.combined).filter((result) => isExternalSource(result.url));

    for (const source of candidate.sources.slice(0, 3)) {
      const strict = extractOwnerContactsStrict(`${source.label}. ${source.snippet || ""}`, candidate.name, business.name!);
      source.phones = strict.phones; source.emails = strict.emails;
      candidate.phones = uniq([...candidate.phones, ...strict.phones]); candidate.emails = uniq([...candidate.emails, ...strict.emails]);
    }

    await Promise.all(directResults.slice(0, 10).map(async (result) => {
      const snippetText = `${result.title}. ${result.snippet}`;
      const snippetContact = extractOwnerContactsStrict(snippetText, candidate.name, business.name!);
      let pageContact = { phones: [] as string[], emails: [] as string[] };
      if (!snippetContact.phones.length && !snippetContact.emails.length) {
        const visible = await fetchVisible(result.url);
        if (visible) pageContact = extractOwnerContactsStrict(visible, candidate.name, business.name!);
      }
      candidate.phones = uniq([...candidate.phones, ...snippetContact.phones, ...pageContact.phones]);
      candidate.emails = uniq([...candidate.emails, ...snippetContact.emails, ...pageContact.emails]);
    }));
  }));

  return { ownerCandidates: ranked, debug, businessContacts };
}

export async function findOwnerCandidates(business: Business) { return (await findOwnerCandidatesWithDebug(business)).ownerCandidates; }
