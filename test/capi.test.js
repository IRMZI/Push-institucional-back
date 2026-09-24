const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildEvent, sha256, resolveFbc } = require("../src/lib/metaCapi");
const { toE164BR } = require("../src/lib/phone");

test("telefone BR vira E.164", () => {
    assert.equal(toE164BR("(51) 99999-8888"), "5551999998888");
    assert.equal(toE164BR("+55 51 3333-4444"), "555133334444");
    assert.equal(toE164BR("51 89999-8888"), null); // celular sem 9
    assert.equal(toE164BR("123"), null);
});

test("payload da CAPI: hash SHA-256 normalizado, dedup por event_id", () => {
    const e = buildEvent({
        eventName: "Lead",
        eventId: "evt-123",
        sourceUrl: "https://pushagencia.com.br/",
        ip: "200.1.2.3",
        ua: "Mozilla",
        fbp: "fb.1.1.2",
        fbclid: "XYZ",
        sessionId: "s-1",
        lead: { nome: "  João  da Silva ", email: " Joao@Ex.com ", whatsapp: "5551999998888" },
    });
    assert.equal(e.event_id, "evt-123");
    assert.equal(e.action_source, "website");
    assert.deepEqual(e.user_data.em, [sha256("joao@ex.com")]);
    assert.deepEqual(e.user_data.ph, [sha256("5551999998888")]);
    assert.deepEqual(e.user_data.fn, [sha256("joao")]);
    assert.deepEqual(e.user_data.ln, [sha256("silva")]);
    assert.match(e.user_data.fbc, /^fb\.1\.\d+\.XYZ$/);
    assert.equal(e.user_data.client_ip_address, "200.1.2.3");
    assert.equal(JSON.stringify(e).includes("Joao@Ex.com"), false);
});

test("fbc existente tem prioridade", () => {
    assert.equal(resolveFbc("fb.1.9.AAA", "BBB"), "fb.1.9.AAA");
    assert.equal(resolveFbc(null, null), undefined);
});
