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

type SearchResult = { title: string; url: string; snippet: string; engine: "duckduckgo" | "bing" };
type SourcePage = { text: string; ok: boolean };

const rolePattern = /(owner|founder|co-founder|president|ceo|managing member|member|principal|proprietor)/i;
const roleExpr = `[Oo]wner|[Ff]ounder|[Cc]o-[Ff]ounder|[Pp]resident|CEO|[Mm]anaging [Mm]ember|[Mm]ember|[Pp]rincipal|[Pp]roprietor`;
const nameWord = `[A-Z][a-zA-Z'-]*`;
const personName = `${nameWord}(?:\\s+${nameWord}){1,2}`;
const blockedWords = new Set(["because", "for", "and", "the", "with", "from", "at", "of", "in", "to", "by", "is", "as", "a", "an", "no-brainer", "principal", "contacts", "customer", "business", "management"]);
const blockedPhrases = ["google maps", "better business", "linkedin", "facebook", "yellow pages", "registered agent", "discover company principals", "customer service", "company profile", "business profile", "contact information"];

const externalSourceDomains = [
  "bbb.org",
  "bizapedia.com",
  "opencorporates.com",
  "linkedin.com",
  "manta.com",
  "einpresswire.com",
  "prweb.com",
  "prnewswire.com",
  "chamberofcommerce.com",
  "yelp.com",
  "facebook.com",
];

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function looksLikePerson(name: string, businessName: string) {
  const normalized = normalize(name);
  const businessNormalized = normalize(businessName);
  if (!normalized || normalized === businessNormalized) return false;
  if (businessNormalized.includes(normalized) || normalized.includes(businessNormalized)) return false;
  if (blockedPhrases.some((phrase) => normalized.includes(phrase))) return false;
  const words = name.trim().split(/\s+/);
  if (words.length < 2 || words.length > 3) return false;
  if (words.some((word) => blockedWords.has(word.toLowerCase()))) return false;
  if (words.some((word) => !/^[A-Z][a-zA-Z'-]*$/.test(word))) return false;
  return true;
}

function extractPeopleNearRoles(text: string, businessName: string) {
  const matches: Array<{ name: string; title: string }> = [];
  const patterns = [
    new RegExp(`(?:Mr\\.?|Ms\\.?|Mrs\\.?)?\\s*(${personName})\\s*[-–—,:|]\\s*(${roleExpr})\\b`, "g"),
    new RegExp(`\\b(${roleExpr})\\b\\s*(?:of\\s+)?[-–—,:|]?\\s*(?:Mr\\.?|Ms\\.?|Mrs\\.?)?\\s*(${personName})\\b`, "g"),
    new RegExp(`(?:Mr\\.?|Ms\\.?|Mrs\\.?)?\\s*(${personName})\\s+(?:is|was|serves as|works as)\\s+(?:the\\s+)?(${roleExpr})\\b`, "g"),
    new RegExp(`(?:Mr\\.?|Ms\\.?|Mrs\\.?)?\\s*(${personName})\\s*,[^.!?]{0,70}?\\b(${roleExpr})\\b`, "g"),
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

function uniq(values: string[]) {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function extractPhones(text: string) {
  const matches = text.match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]\d{4}/g) || [];
  return uniq(matches).slice(0, 6);
}

function extractEmails(text: string) {
  const matches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return uniq(matches).filter((email) => !/example\.(com|org|net)$/i.test(email)).slice(0, 6);
}

function extractNearby(text: string, needle: string, radius = 150) {
  const haystack = text.toLowerCase();
  const target = needle.toLowerCase();
  const chunks: string[] = [];
  let from = 0;
  while (from < haystack.length) {
    const index = haystack.indexOf(target, from);
    if (index === -1) break;
    const start = Math.max(0, index - radius);
    const end = Math.min(text.length, index + target.length + radius);
    chunks.push(text.slice(start, end));
    from = index + target.length;
    if (chunks.length >= 8) break;
  }
  return chunks.join(" ");
}

function extractVerifiedContacts(text: string, ownerName: string) {
  const nearby = extractNearby(text, ownerName, 150);
  if (!nearby) return { phones: [] as string[], emails: [] as string[] };
  return { phones: extractPhones(nearby), emails: extractEmails(nearby) };
}

function decodeDuckDuckGoUrl(href: string) {
  try {
    const url = new URL(href, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : url.href;
  } catch {
    return href;
  }
}

function isExternalSource(url: string) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return externalSourceDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function sourceWeight(url: string) {
  const value = url.toLowerCase();
  if (value.includes("bbb.org")) return 12;
  if (value.includes("opencorporates.com") || value.includes("bizapedia.com")) return 10;
  if (value.includes("manta.com") || value.includes("chamberofcommerce.com")) return 8;
  if (value.includes("linkedin.com")) return 7;
  if (value.includes("einpresswire.com") || value.includes("prweb.com") || value.includes("prnewswire.com")) return 7;
  return 4;
}

function parseDdgHtml(html: string): SearchResult[] {
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];
  $(".result").slice(0, 12).each((_, element) => {
    const title = $(element).find(".result__a").text().trim();
    const href = $(element).find(".result__a").attr("href") || "";
    const snippet = $(element).find(".result__snippet").text().replace(/\s+/g, " ").trim();
    if (title && href) results.push({ title, url: decodeDuckDuckGoUrl(href), snippet, engine: "duckduckgo" });
  });
  return results;
}

function parseDdgLite(html: string): SearchResult[] {
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];
  $("a.result-link").slice(0, 12).each((_, element) => {
    const title = $(element).text().trim();
    const href = $(element).attr("href") || "";
    const row = $(element).closest("tr");
    const snippet = row.next().text().replace(/\s+/g, " ").trim();
    if (title && href) results.push({ title, url: decodeDuckDuckGoUrl(href), snippet, engine: "duckduckgo" });
  });
  return results;
}

function parseBingHtml(html: string): SearchResult[] {
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];
  $("li.b_algo").slice(0, 12).each((_, element) => {
    const link = $(element).find("h2 a").first();
    const title = link.text().trim();
    const href = link.attr("href") || "";
    const snippet = $(element).find(".b_caption p, p").first().text().replace(/\s+/g, " ").trim();
    if (title && href) results.push({ title, url: href, snippet, engine: "bing" });
  });
  return results;
}

const searchHeaders = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
  "accept-language": "en-US,en;q=0.9",
};

async function duckDuckGoSearch(query: string) {
  try {
    const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
      headers: searchHeaders,
    });
    if (response.ok) {
      const results = parseDdgHtml(await response.text());
      if (results.length) return results;
    }
  } catch {}

  try {
    const response = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
      headers: searchHeaders,
    });
    if (response.ok) return parseDdgLite(await response.text());
  } catch {}

  return [];
}

async function bingSearch(query: string) {
  try {
    const response = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en-US`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
      headers: searchHeaders,
    });
    if (response.ok) return parseBingHtml(await response.text());
  } catch {}
  return [];
}

async function searchOwnerWeb(query: string) {
  const [ddg, bing] = await Promise.all([duckDuckGoSearch(query), bingSearch(query)]);
  const seen = new Set<string>();
  return [...ddg, ...bing].filter((item) => {
    const key = item.url || `${item.title}|${item.snippet}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchSourcePage(url: string): Promise<SourcePage> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(7000),
      headers: searchHeaders,
    });
    if (!response.ok) return { text: "", ok: false };
    const html = await response.text();
    const $ = cheerio.load(html);
    $("script,style,noscript,svg").remove();
    const text = $("body").text().replace(/\s+/g, " ").trim();
    return { text, ok: Boolean(text) };
  } catch {
    return { text: "", ok: false };
  }
}

export async function findOwnerCandidates(business: Business): Promise<OwnerCandidate[]> {
  if (!business.name) return [];

  const location = business.address ? ` ${business.address}` : "";
  const queries = [
    `"${business.name}" owner${location}`,
    `"${business.name}" president${location}`,
    `"${business.name}" founder${location}`,
    `site:bbb.org "${business.name}"`,
    `site:bizapedia.com "${business.name}"`,
    `site:manta.com "${business.name}"`,
    `site:einpresswire.com "${business.name}"`,
    `site:prweb.com "${business.name}"`,
    `site:prnewswire.com "${business.name}"`,
  ];

  const pages: SearchResult[] = [];
  for (const query of queries) {
    const results = await searchOwnerWeb(query);
    pages.push(...results);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  const uniquePages = new Map<string, SearchResult>();
  for (const page of pages) {
    if (!page.url) continue;
    const key = page.url.replace(/#.*$/, "");
    if (!uniquePages.has(key)) uniquePages.set(key, page);
  }

  const candidates = new Map<string, OwnerCandidate>();

  function addCandidate(person: { name: string; title: string }, result: SearchResult, bonus = 0) {
    const key = normalize(person.name);
    const source = { label: result.title, url: result.url, snippet: result.snippet, phones: [] as string[], emails: [] as string[] };
    const existing = candidates.get(key);
    if (existing) {
      if (!existing.sources.some((item) => item.url === source.url)) existing.sources.push(source);
      existing.confidence = Math.min(98, existing.confidence + 14 + bonus);
      return;
    }

    let confidence = 62 + sourceWeight(result.url) + bonus;
    const combined = `${result.title}. ${result.snippet}`;
    if (normalize(combined).includes(normalize(business.name))) confidence += 6;
    candidates.set(key, {
      name: person.name,
      title: person.title,
      confidence: Math.min(confidence, 92),
      phones: [],
      emails: [],
      sources: [source],
    });
  }

  for (const result of uniquePages.values()) {
    const combined = `${result.title}. ${result.snippet}`;
    for (const person of extractPeopleNearRoles(combined, business.name)) addCandidate(person, result);
  }

  const externalPages = [...uniquePages.values()].filter((result) => isExternalSource(result.url)).slice(0, 16);
  for (const result of externalPages) {
    const page = await fetchSourcePage(result.url);
    if (!page.ok) continue;
    const textForDiscovery = `${result.title}. ${result.snippet}. ${page.text}`;
    for (const person of extractPeopleNearRoles(textForDiscovery, business.name)) addCandidate(person, result, 8);
  }

  const ranked = [...candidates.values()]
    .filter((candidate) => candidate.confidence >= 60)
    .sort((a, b) => b.confidence - a.confidence || b.sources.length - a.sources.length)
    .slice(0, 5);

  for (const candidate of ranked) {
    for (const source of candidate.sources.slice(0, 4)) {
      const snippetText = `${source.label}. ${source.snippet || ""}`;
      const snippetContact = extractVerifiedContacts(snippetText, candidate.name);
      let pageContact = { phones: [] as string[], emails: [] as string[] };
      if (isExternalSource(source.url)) {
        const page = await fetchSourcePage(source.url);
        if (page.ok) pageContact = extractVerifiedContacts(page.text, candidate.name);
      }
      source.phones = uniq([...snippetContact.phones, ...pageContact.phones]);
      source.emails = uniq([...snippetContact.emails, ...pageContact.emails]);
      candidate.phones = uniq([...candidate.phones, ...source.phones]);
      candidate.emails = uniq([...candidate.emails, ...source.emails]);
    }
    if (candidate.phones.length || candidate.emails.length) candidate.confidence = Math.min(98, candidate.confidence + 2);
  }

  return ranked;
}
