import assert from "node:assert/strict";
import test from "node:test";
import { classifyRole, scoreCompanyMatch, searchConnecticutRegistry, searchNycDoingBusiness } from "./owner-sources.ts";

test("role classification separates owners, decision makers, and registered agents", () => {
  assert.equal(classifyRole("Managing Member"), "owner_relationship");
  assert.equal(classifyRole("President"), "decision_maker");
  assert.equal(classifyRole("Registered Agent"), "registered_agent");
});

test("company matching requires location evidence in addition to exact name", () => {
  const matched = scoreCompanyMatch(
    { name: "Smith Roofing LLC", address: "10 Main St, Hartford, CT 06103", phone: "860-555-0100", mapsUrl: "x", mapsStatus: "shell_only" },
    { name: "SMITH ROOFING, LLC", address: "10 Main St", city: "Hartford", state: "CT", zip: "06103" },
  );
  assert.equal(matched.accepted, true);
  assert.ok(matched.score >= 90);

  const rejected = scoreCompanyMatch(
    { name: "Smith Roofing LLC", address: "10 Main St, Hartford, CT 06103", mapsUrl: "x", mapsStatus: "shell_only" },
    { name: "Smith Roofing LLC", city: "Miami", state: "FL", zip: "33101" },
  );
  assert.equal(rejected.accepted, false);
});

test("Connecticut adapter joins a matched company to principals and excludes registered agents", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("n7gp-d28j")) return new Response(JSON.stringify([{ id: "ct-1", name: "SMITH ROOFING LLC", billingstreet: "10 MAIN ST", billingcity: "HARTFORD", billingstate: "CT", billingpostalcode: "06103" }]), { status: 200 });
    return new Response(JSON.stringify([
      { business_id: "ct-1", name__c: "JOHN SMITH", designation: "MANAGING MEMBER" },
      { business_id: "ct-1", name__c: "AGENT SERVICES INC", designation: "REGISTERED AGENT" },
    ]), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await searchConnecticutRegistry({ name: "Smith Roofing LLC", address: "10 Main St, Hartford, CT 06103", mapsUrl: "x", mapsStatus: "shell_only" });
    assert.equal(result.status, "matched");
    assert.equal(result.people.length, 1);
    assert.equal(result.people[0].name, "JOHN SMITH");
    assert.equal(result.people[0].relationshipType, "owner_relationship");
  } finally { globalThis.fetch = originalFetch; }
});

test("Connecticut adapter falls back to normalized token lookup for legal-name punctuation", async () => {
  const originalFetch = globalThis.fetch;
  let masterRequests = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("n7gp-d28j")) {
      masterRequests += 1;
      if (masterRequests === 1) return new Response("[]", { status: 200 });
      assert.match(decodeURIComponent(url).replace(/\+/g, " "), /upper\(name\) like '%MACK%TOWING%'/);
      return new Response(JSON.stringify([{ id: "ct-2", name: "D-Mack Towing, LLC", billingstreet: "1223 Park Avenue", billingcity: "Bridgeport", billingstate: "CT", billingpostalcode: "06604" }]), { status: 200 });
    }
    return new Response(JSON.stringify([{ business_id: "ct-2", name__c: "DORETH MCKENZIE", designation: "MANAGING MEMBER" }]), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await searchConnecticutRegistry({ name: "D-Mack Towing LLC", address: "1223 Park Avenue, Bridgeport, CT 06604", mapsUrl: "x", mapsStatus: "shell_only" });
    assert.equal(result.status, "matched");
    assert.equal(result.people[0].name, "DORETH MCKENZIE");
    assert.equal(result.people[0].relationshipType, "owner_relationship");
  } finally { globalThis.fetch = originalFetch; }
});

test("NYC adapter maps OWN relationship to owner", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("72mk-a8z7")) return new Response(JSON.stringify([{ organization_name: "ACE TOWING LLC", organization_phone: "2125550100" }]), { status: 200 });
    return new Response(JSON.stringify([{ organization_name: "ACE TOWING LLC", person_name_first: "JANE", person_name_last: "DOE", relationship_type_code: "OWN" }]), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await searchNycDoingBusiness({ name: "Ace Towing LLC", address: "Queens, NY 11368", phone: "(212) 555-0100", mapsUrl: "x", mapsStatus: "shell_only" });
    assert.equal(result.status, "matched");
    assert.equal(result.people[0].name, "JANE DOE");
    assert.equal(result.people[0].relationshipType, "owner_relationship");
  } finally { globalThis.fetch = originalFetch; }
});
