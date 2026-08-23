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
    results: Array<{ engine: "duckduckgo" | "bing"; title: string; url: string; snippet: string; extracted: Array<{ name: string; title: string }> }>;
  }>;
};

type SearchResult = { title: string; url: string; snippet: string; engine: "duckduckgo" | "bing" };

const rolePattern = /(owner|founder|co-founder|president|ceo|managing member|member|principal|proprietor)/i;
const roleExpr = `[Oo]wner|[Ff]ounder|[Cc]o-[Ff]ounder|[Pp]resident|CEO|[Mm]anaging [Mm]ember|[Mm]ember|[Pp]rincipal|[Pp]roprietor`;
const nameWord = `[A-Z][a-zA-Z'-]*`;
const personName = `${nameWord}(?:\\s+${nameWord}){1,2}`;
const blockedWords = new Set(["because","for","and","the","with","from","at","of","in","to","by","is","as","a","an","principal","contacts","customer","business","management","registered","agent","company","service","services"]);

function normalize(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function looksLikePerson(name: string, businessName: string) {
  const words = name.trim().split(/\s+/); const normalized = normalize(name); const businessNormalized = normalize(businessName);
  if (!normalized || normalized === businessNormalized || businessNormalized.includes(normalized) || normalized.includes(businessNormalized)) return false;
  if (words.length < 2 || words.length > 3 || words.some((w) => blockedWords.has(w.toLowerCase())) || words.some((w) => !/^[A-Z][a-zA-Z'-]*$/.test(w))) return false;
  return true;
}
function extractPeopleNearRoles(text: string, businessName: string) {
  const matches: Array<{ name: string; title: string }> = [];
  const patterns = [
    new RegExp(`(?:Mr\\.?|Ms\\.?|Mrs\\.?)?\\s*(${personName})\\s*[-–—,:|]\\s*(${roleExpr})\\b`, "g"),
    new RegExp(`\\b(${roleExpr})\\b\\s*(?:of\\s+)?[-–—,:|]?\\s*(?:Mr\\.?|Ms\\.?|Mrs\\.?)?\\s*(${personName})\\b`, "g"),
    new RegExp(`(?:Mr\\.?|Ms\\.?|Mrs\\.?)?\\s*(${personName})\\s+(?:is|was|serves as|works as)\\s+(?:the\\s+)?(${roleExpr})\\b`, "g"),
    new RegExp(`(?:Mr\\.?|Ms\\.?|Mrs\\.?)?\\s*(${personName})\\s*,[^.!?]{0,80}?\\b(${roleExpr})\\b`, "g"),
  ];
  for (const pattern of patterns) { let match: RegExpExecArray | null; while ((match = pattern.exec(text))) { const first = match[1] || ""; const second = match[2] || ""; const firstIsRole = rolePattern.test(first); const name = (firstIsRole ? second : first).trim(); const title = (firstIsRole ? first : second).trim(); if (looksLikePerson(name, businessName)) matches.push({ name, title }); } }
  const seen = new Set<string>(); return matches.filter((x) => { const k = `${normalize(x.name)}|${normalize(x.title)}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
function uniq(values: string[]) { return [...new Set(values.map((v) => v.trim()).filter(Boolean))]; }
function extractPhones(text: string) { return uniq(text.match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]\d{4}/g) || []).slice(0, 6); }
function extractEmails(text: string) { return uniq(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).filter((e) => !/example\.(com|org|net)$/i.test(e)).slice(0, 6); }
function extractNearby(text: string, needle: string, radius = 150) { const haystack = text.toLowerCase(); const target = needle.toLowerCase(); const chunks: string[] = []; let from = 0; while (from < haystack.length) { const i = haystack.indexOf(target, from); if (i === -1) break; chunks.push(text.slice(Math.max(0, i-radius), Math.min(text.length, i+target.length+radius))); from = i + target.length; if (chunks.length >= 6) break; } return chunks.join(" "); }
function extractVerifiedContacts(text: string, ownerName: string) { const nearby = extractNearby(text, ownerName); return nearby ? { phones: extractPhones(nearby), emails: extractEmails(nearby) } : { phones: [] as string[], emails: [] as string[] }; }
function decodeDuckDuckGoUrl(href: string) { try { const url = new URL(href, "https://duckduckgo.com"); const uddg = url.searchParams.get("uddg"); return uddg ? decodeURIComponent(uddg) : url.href; } catch { return href; } }
function parseDdgHtml(html: string): SearchResult[] { const $ = cheerio.load(html); const out: SearchResult[] = []; $(".result").slice(0,10).each((_,el) => { const title=$(el).find(".result__a").text().trim(); const href=$(el).find(".result__a").attr("href")||""; const snippet=$(el).find(".result__snippet").text().replace(/\s+/g," ").trim(); if(title&&href) out.push({title,url:decodeDuckDuckGoUrl(href),snippet,engine:"duckduckgo"}); }); return out; }
function parseDdgLite(html: string): SearchResult[] { const $=cheerio.load(html); const out:SearchResult[]=[]; $("a.result-link").slice(0,10).each((_,el)=>{const title=$(el).text().trim();const href=$(el).attr("href")||"";const snippet=$(el).closest("tr").next().text().replace(/\s+/g," ").trim();if(title&&href)out.push({title,url:decodeDuckDuckGoUrl(href),snippet,engine:"duckduckgo"});});return out; }
function parseBingHtml(html:string):SearchResult[]{const $=cheerio.load(html);const out:SearchResult[]=[];$("li.b_algo").slice(0,10).each((_,el)=>{const link=$(el).find("h2 a").first();const title=link.text().trim();const href=link.attr("href")||"";const snippet=$(el).find(".b_caption p, p").first().text().replace(/\s+/g," ").trim();if(title&&href)out.push({title,url:href,snippet,engine:"bing"});});return out;}
const headers={"user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36","accept-language":"en-US,en;q=0.9"};
async function duckDuckGoSearch(query:string){try{const r=await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,{cache:"no-store",signal:AbortSignal.timeout(4500),headers});if(r.ok){const p=parseDdgHtml(await r.text());if(p.length)return p;}}catch{} try{const r=await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,{cache:"no-store",signal:AbortSignal.timeout(4500),headers});if(r.ok)return parseDdgLite(await r.text());}catch{} return [];}
async function bingSearch(query:string){try{const r=await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en-US`,{cache:"no-store",signal:AbortSignal.timeout(4500),headers});if(r.ok)return parseBingHtml(await r.text());}catch{}return [];}
async function fetchPublicSource(url:string,ownerName:string){try{const r=await fetch(url,{redirect:"follow",cache:"no-store",signal:AbortSignal.timeout(4500),headers});if(!r.ok)return{phones:[] as string[],emails:[] as string[]};const $=cheerio.load(await r.text());$("script,style,noscript,svg").remove();return extractVerifiedContacts($("body").text().replace(/\s+/g," "),ownerName);}catch{return{phones:[] as string[],emails:[] as string[]};}}

export async function findOwnerCandidatesWithDebug(business: Business): Promise<{ ownerCandidates: OwnerCandidate[]; debug: OwnerDebug }> {
  const debug: OwnerDebug={queries:[]}; if(!business.name)return{ownerCandidates:[],debug};
  const location=business.address?` ${business.address}`:"";
  const queries=[`"${business.name}" owner${location}`,`"${business.name}" president${location}`,`site:bbb.org "${business.name}"`,`site:bizapedia.com "${business.name}"`];
  const batches=await Promise.all(queries.map(async query=>{const [ddg,bing]=await Promise.all([duckDuckGoSearch(query),bingSearch(query)]);return{query,ddg,bing};}));
  const candidates=new Map<string,OwnerCandidate>();
  for(const {query,ddg,bing} of batches){const seen=new Set<string>();const combined=[...ddg,...bing].filter(item=>{const key=item.url||`${item.title}|${item.snippet}`;if(seen.has(key))return false;seen.add(key);return true;});const debugResults=combined.map(result=>({engine:result.engine,title:result.title,url:result.url,snippet:result.snippet,extracted:extractPeopleNearRoles(`${result.title}. ${result.snippet}`,business.name!)}));debug.queries.push({query,duckduckgoCount:ddg.length,bingCount:bing.length,results:debugResults});for(const result of combined){const text=`${result.title}. ${result.snippet}`;for(const person of extractPeopleNearRoles(text,business.name)){const key=normalize(person.name);const source={label:result.title,url:result.url,snippet:result.snippet,phones:[] as string[],emails:[] as string[]};const existing=candidates.get(key);if(existing){if(!existing.sources.some(s=>s.url===source.url))existing.sources.push(source);existing.confidence=Math.min(98,existing.confidence+16);}else{let confidence=64;if(/bbb|bizapedia|linkedin/i.test(`${result.title} ${result.url}`))confidence+=8;if(normalize(text).includes(normalize(business.name)))confidence+=8;candidates.set(key,{name:person.name,title:person.title,confidence,phones:[],emails:[],sources:[source]});}}}}
  const ranked=[...candidates.values()].sort((a,b)=>b.confidence-a.confidence||b.sources.length-a.sources.length).slice(0,5);
  for(const candidate of ranked){const enriched=await Promise.all(candidate.sources.slice(0,2).map(async source=>{const snippet=extractVerifiedContacts(`${source.label}. ${source.snippet||""}`,candidate.name);const page=await fetchPublicSource(source.url,candidate.name);return{source,phones:uniq([...snippet.phones,...page.phones]),emails:uniq([...snippet.emails,...page.emails])};}));for(const item of enriched){item.source.phones=item.phones;item.source.emails=item.emails;candidate.phones=uniq([...candidate.phones,...item.phones]);candidate.emails=uniq([...candidate.emails,...item.emails]);}}
  return{ownerCandidates:ranked,debug};
}
export async function findOwnerCandidates(business:Business){return(await findOwnerCandidatesWithDebug(business)).ownerCandidates;}
