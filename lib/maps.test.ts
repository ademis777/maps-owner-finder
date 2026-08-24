import assert from "node:assert/strict";
import test from "node:test";
import { classifyMapsResponse, mergeMapsWithSeed, parseAddressParts, parseEmbeddedMapsPayload, parseHtmlMetadata, parseMapsUrl, resolveGoogleMapsBusiness } from "./maps.ts";

function placeRecord(overrides: Record<number, unknown> = {}) {
  const record: unknown[] = [];
  record[2] = ["10 Main St", "Hartford, CT 06103", "United States"];
  record[7] = ["/url?q=https://smithroofing.example/&sa=U", "smithroofing.example"];
  record[9] = [null, null, 41.7658, -72.6734];
  record[10] = "0xabc:0xdef";
  record[11] = "Smith Roofing LLC";
  record[13] = ["Roofing contractor"];
  record[39] = "10 Main St, Hartford, CT 06103, United States";
  record[42] = "https://www.google.com/maps/place/Smith+Roofing+LLC/data=!4m2!3m1!1s0xabc:0xdef";
  record[78] = "ChIJ-test-place";
  record[178] = [["+1 860-555-0100", [["(860) 555-0100", 1]]]];
  for (const [key, value] of Object.entries(overrides)) record[Number(key)] = value;
  return record;
}

function payload(record = placeRecord()) { return `)]}'\n${JSON.stringify([["Smith Roofing LLC", [[null,null,null,null,null,null,null,null,null,null,null,null,null,null,record]]]])}`; }
function shell(alternate = true) { return `<html><head><title>Google Maps</title>${alternate ? '<link href="/search?tbm=map&amp;q=Smith+Roofing+LLC&amp;pb=test">' : ""}</head></html>`; }

test("generic Maps shell is shell_only", () => {
  const result = classifyMapsResponse({ httpStatus: 200, html: "<html><title>Google Maps</title></html>", title: "Google Maps", hasBusinessData: false });
  assert.equal(result.status, "shell_only");
});

test("long Maps place URL exposes name, coordinates, and place identity", () => {
  const result = parseMapsUrl("https://www.google.com/maps/place/Smith+Roofing+LLC/@41.7658,-72.6734,15z/data=!4m2!3m1!1s0xabc:0xdef");
  assert.equal(result.name, "Smith Roofing LLC"); assert.equal(result.coordinates?.latitude, 41.7658); assert.equal(result.placeId, "0xabc:0xdef");
});

test("canonical preview URL exposes business address and state without HTML", () => {
  const result = parseMapsUrl("https://www.google.com/maps/preview/place/Smith+Roofing+LLC,+10+Main+St,+Hartford,+CT+06103/@41.7,-72.6,15z/data=!4m2!3m1!1s0xabc:0xdef");
  assert.equal(result.name, "Smith Roofing LLC"); assert.equal(result.address, "10 Main St, Hartford, CT 06103"); assert.equal(result.state, "CT");
});

test("encoded Maps search URL exposes a decoded business name", () => {
  assert.equal(parseMapsUrl("https://www.google.com/maps/search/?api=1&query=John%27s%20Auto%20Repair").name, "John's Auto Repair");
});

test("Maps search query separates company from a structured US address", () => {
  const result = parseMapsUrl("https://www.google.com/maps/search/?api=1&query=Jets+Towing+Inc%2C+918+E+51st+St%2C+Brooklyn%2C+NY+11203");
  assert.equal(result.name, "Jets Towing Inc");
  assert.equal(result.address, "918 E 51st St, Brooklyn, NY 11203");
  assert.equal(result.city, "Brooklyn");
  assert.equal(result.state, "NY");
  assert.equal(result.zip, "11203");
});

test("address parser extracts city, state, and ZIP", () => {
  assert.deepEqual(parseAddressParts("10 Main St, Hartford, Connecticut 06103, United States"), { city: "Hartford", state: "CT", zip: "06103", error: undefined });
});

test("HTML metadata and JSON-LD are independent strategies", () => {
  const html = `<html><head><meta property="og:title" content="Smith Roofing LLC - Google Maps"><script type="application/ld+json">{"@type":"RoofingContractor","name":"Smith Roofing LLC","telephone":"860-555-0100","address":{"streetAddress":"10 Main St","addressLocality":"Hartford","addressRegion":"CT","postalCode":"06103"}}</script></head></html>`;
  const parsed = parseHtmlMetadata(html); assert.equal(parsed.meta.name, "Smith Roofing LLC"); assert.equal(parsed.jsonLd[0].phone, "860-555-0100"); assert.equal(parsed.jsonLd[0].state, "CT");
});

test("structured Maps payload extracts business phone as business metadata", () => {
  const result = parseEmbeddedMapsPayload(payload(), "Smith Roofing LLC");
  assert.equal(result?.phone, "+1 860-555-0100"); assert.equal(result?.website, "https://smithroofing.example/"); assert.equal(result?.category, "Roofing contractor");
});

test("nearby Maps company with a different identity is rejected", () => {
  const other = placeRecord({ 11: "A & C Towing LLC", 39: "39 Hubbell St, Bridgeport, CT 06605", 2: ["39 Hubbell St", "Bridgeport, CT 06605"], 13: ["Towing service"] });
  assert.equal(parseEmbeddedMapsPayload(payload(other), "D-Mack Towing LLC Bridgeport CT"), undefined);
});

test("identity mismatch preserves company and address parsed from input URL", async () => {
  const other = placeRecord({ 11: "A & C Towing LLC", 39: "39 Hubbell St, Bridgeport, CT 06605", 2: ["39 Hubbell St", "Bridgeport, CT 06605"], 13: ["Towing service"] });
  let call = 0;
  const fetcher = async () => { call++; const response = new Response(call === 1 ? shell() : payload(other), { status: 200 }); Object.defineProperty(response, "url", { value: "https://www.google.com/maps" }); return response; };
  const result = await resolveGoogleMapsBusiness("https://www.google.com/maps/preview/place/D-Mack+Towing+LLC,+1223+Park+Ave,+Bridgeport,+CT+06604", { fetcher });
  assert.equal(result.name, "D-Mack Towing LLC");
  assert.equal(result.address, "1223 Park Ave, Bridgeport, CT 06604");
  assert.equal(result.mapsStrategies?.find((item) => item.strategy === "embedded_payload")?.reason, "maps_candidate_identity_mismatch");
});

test("Maps plus seed keeps reliable Maps fields and fills missing seed fields", () => {
  const merged = mergeMapsWithSeed({ name:"Maps Name", mapsUrl:"x", mapsStatus:"resolved", mapsFieldEvidence:{ name:{ value:"Maps Name", source:"embedded_payload", confidence:94 } } }, { name:"Seed Name", address:"Seed Address" });
  assert.equal(merged.name, "Maps Name"); assert.equal(merged.address, "Seed Address"); assert.equal(merged.mapsFieldEvidence?.address?.source, "seed");
});

test("low-confidence URL value does not replace exact seed", () => {
  const merged = mergeMapsWithSeed({ name:"Roofers near me", mapsUrl:"x", mapsStatus:"partial", mapsFieldEvidence:{ name:{ value:"Roofers near me", source:"url", confidence:35 } } }, { name:"Smith Roofing LLC" });
  assert.equal(merged.name, "Smith Roofing LLC"); assert.equal(merged.mapsFieldEvidence?.name?.source, "seed");
});

test("maps.app.goo.gl redirect is parsed before embedded payload merge", async () => {
  const calls:string[]=[];const fetcher=async(input:string|URL,_init?:RequestInit)=>{calls.push(String(input));if(calls.length===1)return new Response(shell(),{status:200,headers:{}}) as Response & {url:string};return new Response(payload(),{status:200});};
  Object.defineProperty(await fetcher("warmup"),"url",{value:"https://example.invalid"}); calls.length=0;
  const redirecting=async(input:string|URL,init?:RequestInit)=>{const response=await fetcher(input,init);Object.defineProperty(response,"url",{value:calls.length===1?"https://www.google.com/maps/place/Smith+Roofing+LLC":"https://www.google.com/search"});return response;};
  const result=await resolveGoogleMapsBusiness("https://maps.app.goo.gl/abc",{fetcher:redirecting});assert.equal(result.name,"Smith Roofing LLC");assert.equal(result.mapsStatus,"resolved");assert.equal(calls.length,2);
});

test("a true shell page remains shell_only", async () => {
  const fetcher=async()=>{const response=new Response(shell(false),{status:200});Object.defineProperty(response,"url",{value:"https://www.google.com/maps"});return response;};
  const result=await resolveGoogleMapsBusiness("https://www.google.com/maps",{fetcher});assert.equal(result.mapsStatus,"shell_only");
});

test("timeout does not break exact seed fallback", async () => {
  const timeout=Object.assign(new Error("timed out"),{name:"TimeoutError"});
  const resolved=await resolveGoogleMapsBusiness("https://www.google.com/maps/search/?api=1&query=Smith%20Roofing",{fetcher:async()=>{throw timeout;}});
  const merged=mergeMapsWithSeed(resolved,{name:"Smith Roofing LLC",address:"10 Main St, Hartford, CT 06103"});
  assert.equal(merged.name,"Smith Roofing LLC");assert.equal(merged.address,"10 Main St, Hartford, CT 06103");assert.equal(resolved.mapsStatus,"timeout");
});
