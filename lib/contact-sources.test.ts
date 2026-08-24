import assert from "node:assert/strict";
import test from "node:test";
import { parseStructuredPublicDocumentContact, reconcilePublicDocumentPerson, searchFmcsaContact, searchNycDcwpApplications, searchNycDobLicense, searchPublicDocumentContact } from "./contact-sources.ts";
import { classifyOwnerContact } from "./owners.ts";

const business = { name: "Smith Roofing LLC", address: "10 Main St, Brooklyn, NY 11210", phone: "718-555-0100", mapsUrl: "x", mapsStatus: "shell_only" as const };

test("professional registry contact tied to exact person and company is a possible direct contact", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify([{
    first_name: "JOHN", last_name: "SMITH", business_name: "SMITH ROOFING LLC", license_business_city: "BROOKLYN", business_state: "NY", business_zip_code: "11210", business_phone_number: "917-555-0111", license_type: "GENERAL CONTRACTOR",
  }]), { status: 200 })) as typeof fetch;
  try {
    const source = await searchNycDobLicense("John Smith", business);
    assert.equal(source.status, "matched");
    const raw = source.candidatesFound[0];
    const contact = classifyOwnerContact({ value: raw.value, kind: raw.kind, sourceUrl: raw.sourceUrl, evidenceText: raw.evidenceText, ownerName: raw.personName, businessName: raw.companyName, businessPhones: [business.phone] });
    assert.equal(contact.contactType, "possible_direct");
    assert.equal(contact.normalizedValue, "9175550111");
  } finally { globalThis.fetch = originalFetch; }
});

test("professional registry rejects a contact for another person", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify([{ first_name: "JANE", last_name: "DOE", business_name: "SMITH ROOFING LLC", business_state: "NY", business_phone_number: "9175550111" }]), { status: 200 })) as typeof fetch;
  try {
    const source = await searchNycDobLicense("John Smith", business);
    assert.equal(source.candidatesFound.length, 0);
    assert.match(source.rejectedCandidates[0].reason, /different person/i);
  } finally { globalThis.fetch = originalFetch; }
});

test("professional registry rejects exact person from another company and city", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify([{ first_name: "JOHN", last_name: "SMITH", business_name: "OTHER PLUMBING LLC", license_business_city: "ALBANY", business_state: "NY", business_zip_code: "12207", business_email: "john@other.example" }]), { status: 200 })) as typeof fetch;
  try {
    const source = await searchNycDobLicense("John Smith", business);
    assert.equal(source.candidatesFound.length, 0);
    assert.match(source.rejectedCandidates[0].reason, /company\/location did not/i);
  } finally { globalThis.fetch = originalFetch; }
});

test("blocked professional source is reported as blocked rather than empty", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("blocked", { status: 429 })) as typeof fetch;
  try { assert.equal((await searchNycDobLicense("John Smith", business)).status, "blocked"); }
  finally { globalThis.fetch = originalFetch; }
});

test("DCWP company application phone is rejected when applicant is not the confirmed person", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => String(input).includes("John+Smith")
    ? new Response("[]", { status: 200 })
    : new Response(JSON.stringify([{ application_id: "a1", business_name: "Smith Roofing", contact_phone: "7185550100", city: "BROOKLYN", state: "NY", zip: "11210" }]), { status: 200 })) as typeof fetch;
  try {
    const source = await searchNycDcwpApplications("John Smith", business);
    assert.equal(source.candidatesFound.length, 0);
    assert.equal(source.rejectedCandidates[0].value, "7185550100");
    assert.match(source.rejectedCandidates[0].reason, /not the confirmed person/i);
  } finally { globalThis.fetch = originalFetch; }
});

const dMack = { name: "D-Mack Towing LLC", address: "1223 Park Avenue, Bridgeport, CT 06604", city: "Bridgeport", state: "CT", category: "Towing service", phone: "203-555-0100", mapsUrl: "x", mapsStatus: "resolved" as const };
const registerUrl = "https://li-public.fmcsa.dot.gov/lihtml/rptspdf/LI_REGISTER20211214.PDF";
const registerBlock = `DECISIONS AND NOTICES RELEASED December 14, 2021
MC-1352439
12/09/2021
DORMACK TRANSPORTATION LLC
DORETH MCKENZIE
1219 PARK AVE
BRIDGEPORT, CT 06604
Tel: 2035454569`;
const fmcsaOptions = (block = registerBlock, currentPhone = "203-923-4047") => ({
  search: async () => [{ title: "LI_REGISTER20211214.PDF", url: registerUrl, snippet: block }],
  currentCarrier: async () => ({ phone: currentPhone, usdot: "3779518", entityName: "DORMACK TRANSPORTATION LLC", state: "CT" }),
});

test("exact person plus FMCSA entity and phone creates a contact candidate", async () => {
  const result = await searchFmcsaContact("Doreth McKenzie", dMack, fmcsaOptions());
  assert.equal(result.status, "matched");
  assert.equal(result.candidatesFound[0].normalizedValue, "2035454569");
  assert.match(result.candidatesFound[0].evidenceText, /MC-1352439/);
});

test("historical FMCSA phone remains separate from current company phone", async () => {
  const result = await searchFmcsaContact("Doreth McKenzie", dMack, fmcsaOptions());
  assert.equal(result.historicalPhone, "2035454569");
  assert.equal(result.currentCompanyPhone, "203-923-4047");
  assert.notEqual(result.candidatesFound[0].normalizedValue, "2039234047");
});

test("historical phone equal to current business phone is not automatically direct", async () => {
  const result = await searchFmcsaContact("Doreth McKenzie", dMack, fmcsaOptions(registerBlock, "203-545-4569"));
  const raw = result.candidatesFound[0];
  const contact = classifyOwnerContact({ value: raw.value, kind: raw.kind, sourceUrl: raw.sourceUrl, evidenceText: raw.evidenceText, ownerName: raw.personName, businessName: raw.companyName, businessPhones: raw.relatedBusinessPhones });
  assert.equal(contact.contactType, "business");
});

test("similar transport company without exact person is rejected", async () => {
  const result = await searchFmcsaContact("Doreth McKenzie", dMack, fmcsaOptions(registerBlock.replace("DORETH MCKENZIE", "DOROTHY MACKENZIE")));
  assert.equal(result.candidatesFound.length, 0);
});

test("exact person in another state FMCSA entity is rejected", async () => {
  const otherState = registerBlock.replace("BRIDGEPORT, CT 06604", "MIAMI, FL 33101");
  const result = await searchFmcsaContact("Doreth McKenzie", dMack, fmcsaOptions(otherState));
  assert.equal(result.candidatesFound.length, 0);
  assert.match(result.rejectedCandidates[0].reason, /city\/state/i);
});

test("absence of an indexed FMCSA relationship returns empty", async () => {
  const result = await searchFmcsaContact("Doreth McKenzie", dMack, { search: async () => [] });
  assert.equal(result.status, "empty");
  assert.equal(result.candidatesFound.length, 0);
});

const jets = { name: "Jets Towing Inc", address: "918 E 51st St, Brooklyn, NY 11203", city: "Brooklyn", state: "NY", category: "Towing service", phone: "718-251-7200", mapsUrl: "x", mapsStatus: "resolved" as const };
const mtaUrl = "https://www.mta.info/document/130376";
const mtaRow = "Vendor | Contact Name | Email ID | Telephone\nJets Towing Inc. | Charles Gampero Jr | jetstowing1967@gmail.com | 718/251-7200";

test("exact/reconciled named vendor row yields email while business phone stays business", async () => {
  const parsed = parseStructuredPublicDocumentContact(mtaRow, "Charle S L Gampero", jets, mtaUrl);
  assert.equal(parsed.candidates.length, 2);
  const email = parsed.candidates.find((item) => item.kind === "email")!;
  const phone = parsed.candidates.find((item) => item.kind === "phone")!;
  assert.match(parsed.reconciliation!, /Charle\/Charles/i);
  assert.equal(classifyOwnerContact({ value: email.value, kind: email.kind, sourceUrl: email.sourceUrl, evidenceText: email.evidenceText, ownerName: email.personName, businessName: email.companyName, businessPhones: [jets.phone], sourceName: email.sourceName }).contactType, "verified_direct");
  assert.equal(classifyOwnerContact({ value: phone.value, kind: phone.kind, sourceUrl: phone.sourceUrl, evidenceText: phone.evidenceText, ownerName: phone.personName, businessName: phone.companyName, businessPhones: [jets.phone], sourceName: phone.sourceName }).contactType, "business");
});

test("Jr suffix and middle initials do not block cautious same-company person reconciliation", () => {
  assert.equal(reconcilePublicDocumentPerson("Charles S L Gampero", "Charles Gampero Jr.", true).matched, true);
  assert.equal(reconcilePublicDocumentPerson("Charle S L Gampero", "Charles Gampero Jr.", false).matched, false);
});

test("general email in a named vendor row remains general", () => {
  const parsed = parseStructuredPublicDocumentContact(mtaRow.replace("jetstowing1967@gmail.com", "info@jetstowing.com"), "Charle S L Gampero", jets, mtaUrl);
  const raw = parsed.candidates.find((item) => item.kind === "email")!;
  assert.equal(classifyOwnerContact({ value: raw.value, kind: raw.kind, sourceUrl: raw.sourceUrl, evidenceText: raw.evidenceText, ownerName: raw.personName, businessName: raw.companyName }).contactType, "general_email");
});

test("wrong company, wrong person, and unstructured document are rejected", () => {
  assert.equal(parseStructuredPublicDocumentContact(mtaRow.replace("Jets Towing Inc.", "Other Towing LLC"), "Charle S L Gampero", jets, mtaUrl).candidates.length, 0);
  assert.equal(parseStructuredPublicDocumentContact(mtaRow.replace("Charles Gampero Jr", "John Smith"), "Charle S L Gampero", jets, mtaUrl).candidates.length, 0);
  assert.equal(parseStructuredPublicDocumentContact("Jets Towing Inc. won a public contract. Charles Gampero Jr attended.", "Charle S L Gampero", jets, mtaUrl).candidates.length, 0);
});

test("public-document discovery accepts an official structured result without hardcoded URL", async () => {
  const source = await searchPublicDocumentContact("Charle S L Gampero", jets, {
    search: async () => ({ status: "ok", hits: [{ title: "SSE# 0000457639", url: mtaUrl, snippet: mtaRow }] }),
    fetchDocument: async () => ({ status: "blocked", reason: "HTTP 403" }),
  });
  assert.equal(source.status, "matched");
  assert.equal(source.candidatesFound.find((item) => item.kind === "email")?.value, "jetstowing1967@gmail.com");
  assert.equal(source.documentsAccepted?.[0], mtaUrl);
});
