import assert from "node:assert/strict";
import test from "node:test";
import { ownerPersonKey } from "./owners.ts";
import { classifyRole, scoreCompanyMatch } from "./owner-sources.ts";
import { detectState, runStateRegistryAdapters, searchNewYorkStateRegistry, type StateRegistryAdapter } from "./state-registry.ts";

test("legal suffix punctuation normalizes for company matching", () => {
  const result = scoreCompanyMatch({ name: "D-Mack Towing LLC", address: "10 Main St, Albany, NY 12207", mapsUrl: "x", mapsStatus: "shell_only" }, { name: "D-Mack Towing, L.L.C.", address: "10 Main St", city: "Albany", state: "NY", zip: "12207" });
  assert.equal(result.accepted, true);
  assert.match(result.evidence, /exact normalized name/);
});

test("same person case and middle initial variants share a merge key", () => {
  assert.equal(ownerPersonKey("John A. Smith"), ownerPersonKey("JOHN SMITH"));
});

test("strict registry roles preserve agent, owner, and decision-maker separation", () => {
  assert.equal(classifyRole("Registered Agent"), "registered_agent");
  assert.equal(classifyRole("Managing Member"), "owner_relationship");
  assert.equal(classifyRole("President"), "decision_maker");
});

test("unsupported state adapters are skipped without lookup", async () => {
  let called = false;
  const adapter: StateRegistryAdapter = { state: "NY", sourceName: "test", supports: () => false, searchCompany: async () => { called = true; throw new Error("should not run"); }, getPeople: (result) => result.people };
  const [result] = await runStateRegistryAdapters([adapter], { name: "Test LLC", address: "Austin, TX 78701", mapsUrl: "x", mapsStatus: "shell_only" });
  assert.equal(result.registryStatus, "skipped"); assert.equal(called, false);
});

test("timeout in one adapter does not break other state adapters", async () => {
  const timeout: StateRegistryAdapter = { state: "NY", sourceName: "timeout", supports: () => true, searchCompany: async () => { throw new DOMException("timed out", "TimeoutError"); }, getPeople: (result) => result.people };
  const good: StateRegistryAdapter = { state: "NY", sourceName: "good", supports: () => true, searchCompany: async () => ({ sourceName: "good", attempted: true, input: "q", status: "matched", companyMatches: [], rejectedMatches: [], people: [] }), getPeople: (result) => result.people };
  const results = await runStateRegistryAdapters([timeout, good], { name: "Test LLC", address: "Albany, NY 12207", mapsUrl: "x", mapsStatus: "shell_only" });
  assert.equal(results[0].registryStatus, "timeout"); assert.equal(results[1].registryStatus, "matched");
});

test("New York adapter returns CEO only after exact company and address match", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify([{ dos_id: "123", current_entity_name: "AL'S ROOFING & SIDING CORP.", location_address_1: "246 CAMBRIDGE AVE", location_city: "STATEN ISLAND", location_state: "NY", location_zip: "10314", chairman_name: "ALAN M HAGGIAG" }]), { status: 200 })) as typeof fetch;
  try {
    const result = await searchNewYorkStateRegistry({ name: "Al's Roofing & Siding Corp", address: "246 Cambridge Ave, Staten Island, NY 10314", mapsUrl: "x", mapsStatus: "shell_only" });
    assert.equal(result.status, "matched"); assert.equal(result.people[0].role, "CEO"); assert.equal(result.people[0].relationshipType, "decision_maker");
  } finally { globalThis.fetch = originalFetch; }
});

test("ambiguous New York company records do not promote people", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify([
    { dos_id: "1", current_entity_name: "ACE TOWING INC.", location_city: "BROOKLYN", location_state: "NY", chairman_name: "JOHN ONE" },
    { dos_id: "2", current_entity_name: "ACE TOWING INC.", location_city: "BROOKLYN", location_state: "NY", chairman_name: "JOHN TWO" },
  ]), { status: 200 })) as typeof fetch;
  try {
    const result = await searchNewYorkStateRegistry({ name: "Ace Towing Inc", address: "Brooklyn, NY 11210", mapsUrl: "x", mapsStatus: "shell_only" });
    assert.match(result.reason || "", /ambiguous/i); assert.equal(result.people.length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("state detection supports listed states", () => { assert.equal(detectState({ address: "Phoenix, AZ 85001", mapsUrl: "x", mapsStatus: "shell_only" }), "AZ"); });
