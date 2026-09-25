// CMS: conteúdo, cases, mídia e rotas públicas. Requer o mesmo Postgres de teste do api.test.js.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");

const { assertRequiredEnv, config } = require("../src/config");
assertRequiredEnv();
const sql = require("../src/db");
const { migrate } = require("../src/migrate");
const { ensureEnvAdmin } = require("../src/lib/users");
const { createApp } = require("../src/app");

let server, base, token, caseId, mediaId;
const SLUG = "case-teste-cms";

async function api(path, { method = "GET", body, auth = true, raw, headers = {} } = {}) {
    const res = await fetch(base + path, {
        method,
        headers: {
            ...(auth ? { Authorization: `Bearer ${token}` } : {}),
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...headers,
        },
        body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const type = res.headers.get("content-type") || "";
    return { status: res.status, headers: res.headers, body: type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}

before(async () => {
    await migrate(sql);
    await ensureEnvAdmin();
    await sql`DELETE FROM cases WHERE slug LIKE 'case-teste-%'`;
    server = createApp().listen(0);
    base = `http://127.0.0.1:${server.address().port}/api`;
    const r = await api("/auth/login", { method: "POST", auth: false, body: { username: config.adminUsername, password: config.adminPassword } });
    token = r.body.token;
});

after(async () => {
    await sql`DELETE FROM cases WHERE slug LIKE 'case-teste-%'`;
    if (mediaId) await sql`DELETE FROM media WHERE id = ${mediaId}`;
    server.close();
    await sql.end();
});

test("seed: cases atuais migrados e conteúdo público", async () => {
    const r = await api("/public/site", { auth: false });
    assert.equal(r.status, 200);
    const slugs = r.body.cases.map((c) => c.slug);
    for (const s of ["wall-street-imoveis", "distrito-64", "henrique-filipin", "alabama", "donnfit"]) assert.ok(slugs.includes(s), s);
    assert.equal(r.body.conteudo.hero.titulo[0], "WE *PUSH*");
    assert.equal(r.body.cases.find((c) => c.slug === "henrique-filipin").destaque.valor, "+15");
    const again = await api("/public/site", { auth: false, headers: { "If-None-Match": r.headers.get("etag") } });
    assert.equal(again.status, 304);
});

test("CMS exige login", async () => {
    assert.equal((await api("/cms/cases", { auth: false })).status, 401);
    assert.equal((await api("/cms/content/hero", { method: "PUT", auth: false, body: {} })).status, 401);
});

test("upload gera AVIF e WebP responsivos", async () => {
    const png = await sharp({ create: { width: 1600, height: 1000, channels: 3, background: "#164BFF" } }).png().toBuffer();
    const r = await api("/cms/media", { method: "POST", raw: png, headers: { "Content-Type": "image/png", "X-Filename": "capa.png" } });
    assert.equal(r.status, 201);
    mediaId = r.body.id;
    assert.deepEqual(r.body.larguras, [640, 1280, 1600]);
    const avif = await api(`/media/${mediaId}/640.avif`, { auth: false });
    assert.equal(avif.status, 200);
    assert.equal(avif.headers.get("content-type"), "image/avif");
    assert.match(avif.headers.get("cache-control"), /immutable/);
    const meta = await sharp(avif.body).metadata();
    assert.equal(meta.width, 640);
    const bad = await api("/cms/media", { method: "POST", raw: Buffer.from("x"), headers: { "Content-Type": "text/plain" } });
    assert.equal(bad.status, 400);
});

test("case: criar rascunho, editar, publicar, página pública", async () => {
    const payload = {
        slug: SLUG,
        cliente: "Cliente Teste",
        tags: ["Digital"],
        resumo: "Resumo",
        desafio: "Desafio",
        entregas: ["Site"],
        capa_id: mediaId,
        galeria: [{ media_id: mediaId, alt: "Tela", legenda: "Home", largura: "full" }],
        publicado: false,
    };
    const invalid = await api("/cms/cases", { method: "POST", body: { ...payload, slug: "Com Espaço" } });
    assert.equal(invalid.status, 400);
    const c = await api("/cms/cases", { method: "POST", body: payload });
    assert.equal(c.status, 201);
    caseId = c.body.id;
    assert.equal(c.body.capa.id, mediaId);
    assert.equal(c.body.galeria[0].legenda, "Home");

    // rascunho não aparece no site
    assert.equal((await api(`/public/cases/${SLUG}`, { auth: false })).status, 404);
    const dup = await api("/cms/cases", { method: "POST", body: payload });
    assert.equal(dup.status, 409);

    const upd = await api(`/cms/cases/${caseId}`, { method: "PUT", body: { ...payload, cliente: "Cliente Editado", publicado: true } });
    assert.equal(upd.body.cliente, "Cliente Editado");
    const pub = await api(`/public/cases/${SLUG}`, { auth: false });
    assert.equal(pub.status, 200);
    assert.equal(pub.body.case.desafio, "Desafio");
    assert.ok(pub.body.proximo.slug);

    const ids = (await api("/cms/cases")).body.map((x) => x.id);
    const reordered = [caseId, ...ids.filter((i) => i !== caseId)];
    await api("/cms/cases/ordem", { method: "POST", body: { ids: reordered } });
    const site = await api("/public/site?full=1", { auth: false });
    assert.equal(site.body.cases[0].slug, SLUG);
    assert.equal(site.body.cases[0].galeria.length, 1);
    await api("/cms/cases/ordem", { method: "POST", body: { ids } }); // restaura
    await api(`/cms/cases/${caseId}/publicado`, { method: "PATCH", body: { publicado: false } });
    assert.equal((await api(`/public/cases/${SLUG}`, { auth: false })).status, 404);
});

test("conteúdo: validação e atualização", async () => {
    const { body: cur } = await api("/cms/content");
    const hero = cur.conteudo.hero;
    const bad = await api("/cms/content/hero", { method: "PUT", body: { ...hero, titulo: [] } });
    assert.equal(bad.status, 400);
    assert.equal((await api("/cms/content/inexistente", { method: "PUT", body: {} })).status, 404);
    const ok = await api("/cms/content/hero", { method: "PUT", body: { ...hero, subtitulo: "Novo subtítulo de teste" } });
    assert.equal(ok.status, 200);
    const pub = await api("/public/site", { auth: false });
    assert.equal(pub.body.conteudo.hero.subtitulo, "Novo subtítulo de teste");
    await api("/cms/content/hero", { method: "PUT", body: hero }); // restaura
    const contatos = await api("/cms/content/contatos", { method: "PUT", body: { ...cur.conteudo.contatos, whatsapp: "(51) 99999-0000" } });
    assert.equal(contatos.body.whatsapp, "51999990000");
    await api("/cms/content/contatos", { method: "PUT", body: cur.conteudo.contatos });
});
