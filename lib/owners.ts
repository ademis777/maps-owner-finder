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

const rolePattern = /(owner|founder|co-founder|president|ceo|managing member|member|principal|proprietor)/i;
const personName = `[A-Z][a-zA-Z'.-]+(?:\\s+[A-Z][a-zA-Z'.-]+){1,2}`;
const blockedWords = new Set(["because", "for", "and", "the", "with", "from", "at", "of", "in", "to", "by", "is", "as", "a", "an", "no-brainer"]);
const blockedPhrases = ["google maps", "better business", "linkedin", "facebook", "yellow pages", "registered agent", "discover company principals", "customer service", "company profile", "business profile", "contact information"];

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
  if (words.some((word) => !/^[A-Z][a-zA-Z'.-]+$/.test(word))) return false;
  return true;
}

function extractPeopleNearRoles(text: string, businessName: string) {
  const matches: Array<{ name: string; title: string }> = [];
  const patterns = [
    new RegExp(`(${personName})\\s*[-–—,:|]\\s*(owner|founder|co-founder|president|ceo|managing member|member|principal|proprietor)`, "g"),
    new RegExp(`(owner|founder|co-founder|president|ceo|managing member|member|principal|proprietor)\\s*[-–—,:|]?\\s*(${personName})`, "gi"),
    new RegExp(`(${personName})\\s+(?:is|as|serves as|works as)?\\s*(?:the\\s+)?(owner|founder|co-founder|president|ceo|managing member|member|principal|proprietor)`, "g"),
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      const first = match[1] || "";
      const second = match[2] || "";
      const firstIsRole = rolePattern.test(first);
      const name = firstIsRole ? second : first;
      const title = firstIsRole ? first : second;
      if (looksLikePerson(name, businessName)) matches.push({ name: name.trim(), title: title.trim() });
    }
  }
  return matches;
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

function decodeDuckDuckGoUrl(href: string) {
  try {
    const url = new URL(href, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : url.href;
  } catch {
    return href;
  }
}

async function fetchPublicSource(url: string) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(7000),
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
        "accept-language": "en-US,en;q=0.9",
      },
    });
    if (!response.ok) return { phones: [] as string[], emails: [] as string[] };
    const html = await response.text();
    const $ = cheerio.load(html);
    $("script,style,noscript,svg").remove();
    const visible = $("body").text().replace(/\s+/g, " ");
    const combined = `${visible} ${html}`;
    return { phones: extractPhones(combined), emails: extractEmails(combined) };
  } catch {
    return { phones: [] as string[], emails: [] as string[] };
  }
}

async function duckDuckGoSearch(query: string) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, { cache: "no-store", headers: { "user-agent": "Mozilla/5.0", "accept-language": "en-US,en;q=0.9" } });
  if (!response.ok) return [];
  const $ = cheerio.load(await response.text());
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  $(".result").slice(0, 10).each((_, element) => {
    const title = $(element).find(".result__a").text().trim();
    const href = $(element).find(".result__a").attr("href") || "";
    const snippet = $(element).find(".result__snippet").text().replace(/\s+/g, " ").trim();
    if (title && href) results.push({ title, url: decodeDuckDuckGoUrl(href), snippet });
  });
  return results;
}

export async function findOwnerCandidates(business: Business): Promise<OwnerCandidate[]> {
  if (!business.name) return [];
  const location = business.address ? ` ${business.address}` : "";
  const queries = [
    `"${business.name}" owner${location}`,
    `"${business.name}" founder${location}`,
    `"${business.name}" president${location}`,
    `"${business.name}" "managing member"${location}`,
  ];

  const pages = (await Promise.all(queries.map(duckDuckGoSearch))).flat();
  const candidates = new Map<string, OwnerCandidate>();

  for (const result of pages) {
    const combined = `${result.title}. ${result.snippet}`;
    const people = extractPeopleNearRoles(combined, business.name);
    if (!people.length) continue;

    const contact = await fetchPublicSource(result.url);
    const snippetPhones = extractPhones(combined);
    const snippetEmails = extractEmails(combined);
    const sourcePhones = uniq([...snippetPhones, ...contact.phones]);
    const sourceEmails = uniq([...snippetEmails, ...contact.emails]);

    for (const person of people) {
      const key = normalize(person.name);
      const source = { label: result.title, url: result.url, snippet: result.snippet, phones: sourcePhones, emails: sourceEmails };
      const existing = candidates.get(key);
      if (existing) {
        if (!existing.sources.some((item) => item.url === source.url)) existing.sources.push(source);
        existing.phones = uniq([...existing.phones, ...sourcePhones]);
        existing.emails = uniq([...existing.emails, ...sourceEmails]);
        existing.confidence = Math.min(98, existing.confidence + 18);
      } else {
        let confidence = 64;
        if (/bbb|bizapedia|opencorporates|crunchbase|linkedin/i.test(`${result.title} ${result.url}`)) confidence += 8;
        if (normalize(combined).includes(normalize(business.name))) confidence += 8;
        if (sourcePhones.length || sourceEmails.length) confidence += 5;
        candidates.set(key, { name: person.name, title: person.title, confidence: Math.min(confidence, 92), phones: sourcePhones, emails: sourceEmails, sources: [source] });
      }
    }
  }

  return [...candidates.values()]
    .filter((candidate) => candidate.confidence >= 60)
    .sort((a, b) => b.confidence - a.confidence || b.sources.length - a.sources.length)
    .slice(0, 5);
}
