// Teste de integração ponta a ponta. Requer um Postgres de teste em DATABASE_URL:
//   DATABASE_URL=postgres://... JWT_SECRET=... ADMIN_USERNAME=admin ADMIN_PASSWORD=... npm test
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

process.env.META_PIXEL_ID = "";
process.env.META_CAPI_TOKEN = "";

const { assertRequiredEnv, config } = require("../src/config");
assertRequiredEnv();
const sql = require("../src/db");
const { migrate } = require("../src/migrate");
const { ensureEnvAdmin } = require("../src/lib/users");
const { createApp } = require("../src/app");

let server;
let base;
let token;
const sid = crypto.randomUUID();
const visit = crypto.randomUUID();

const api = async (path, { method = "GET", body, auth, headers = {} } = {}) => {
    const res = await fetch(base + path, {
        method,
        headers: {
            ...(body !== undefined && typeof body !== "string" ? { "Content-Type": "application/json" } : {}),
            ...(typeof body === "string" ? { "Content-Type": "text/plain" } : {}),
            ...(auth ? { Authorization: `Bearer ${token}` } : {}),
            ...headers,
        },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        json = text;
    }
    return { status: res.status, body: json, headers: res.headers };
};

before(async () => {
    await sql`DELETE FROM campaigns WHERE utm_campaign = 'push-leads-set-test'`.catch(() => {});
    await sql`DELETE FROM admin_users WHERE username = 'joao.test'`.catch(() => {});
    await migrate(sql);
    await migrate(sql); // idempotência
    await ensureEnvAdmin();
    server = createApp().listen(0);
    base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
    await sql`DELETE FROM visitor_sessions WHERE id = ${sid}`;
    await sql`DELETE FROM leads WHERE event_id LIKE 'test-%'`;
    await sql`DELETE FROM conversoes WHERE event_id LIKE 'test-%'`;
    await sql`DELETE FROM campaigns WHERE utm_campaign = 'push-leads-set-test'`;
    await sql`DELETE FROM admin_users WHERE username = 'joao.test'`;
    server.close();
    await sql.end();
});

test("health", async () => {
    const r = await api("/health");
    assert.equal(r.status, 200);
    assert.equal(r.body.db, "ok");
});

test("login inválido e válido", async () => {
    const bad = await api("/auth/login", { method: "POST", body: { username: config.adminUsername, password: "errada" } });
    assert.equal(bad.status, 401);
    const ok = await api("/auth/login", { method: "POST", body: { username: config.adminUsername, password: config.adminPassword } });
    assert.equal(ok.status, 200);
    token = ok.body.token;
    assert.ok(token);
    const me = await api("/auth/me", { auth: true });
    assert.equal(me.body.username, config.adminUsername);
});

test("rotas do painel exigem token", async () => {
    assert.equal((await api("/leads")).status, 401);
    assert.equal((await api("/dashboard/overview")).status, 401);
});

test("sessão: cria, conta visita e mantém first-touch", async () => {
    const body = {
        id: sid,
        visit_id: visit,
        landing_page: "/?utm_source=meta",
        referrer: "https://www.instagram.com/",
        dispositivo: "mobile",
        browser: "Chrome",
        os: "Android",
        utm: { utm_source: "meta", utm_medium: "cpc", utm_campaign: "push-leads-set", fbclid: "abc123" },
        first_touch: { utm_source: "meta", utm_campaign: "push-leads-set", ts: Date.now() },
        consentimento: "all",
    };
    assert.equal((await api("/sessions", { method: "POST", body })).status, 201);
    // mesma visita de novo não conta duas vezes
    assert.equal((await api("/sessions", { method: "POST", body })).status, 201);
    // nova visita sem UTM: last-touch continua, first-touch não muda
    await api("/sessions", { method: "POST", body: { id: sid, visit_id: crypto.randomUUID(), landing_page: "/", dispositivo: "mobile" } });
    const [s] = await sql`SELECT * FROM visitor_sessions WHERE id = ${sid}`;
    assert.equal(s.visitas, 2);
    assert.equal(s.utm_campaign, "push-leads-set");
    assert.equal(s.ft_utm_source, "meta");
    assert.equal(s.consentimento, "all");
    assert.ok(s.ip_hash && s.ip_hash.length === 64);
});

test("eventos em lote (JSON e sendBeacon text/plain)", async () => {
    const r = await api(`/sessions/${sid}/events`, {
        method: "POST",
        body: {
            visit_id: visit,
            engaged_seconds: 42,
            events: [
                { tipo: "page_view", pagina: "/" },
                { tipo: "section_view", nome: "servicos" },
                { tipo: "section_view", nome: "cases" },
                { tipo: "scroll_depth", valor: 75 },
                { tipo: "case_click", nome: "wall-street-imoveis" },
                { tipo: "form_open", nome: "contato" },
            ],
        },
    });
    assert.equal(r.status, 202);
    const beacon = await api(`/sessions/${sid}/events`, {
        method: "POST",
        body: JSON.stringify({ visit_id: visit, engaged_seconds: 8, events: [{ tipo: "time_on_page", pagina: "/", valor: 50 }] }),
    });
    assert.equal(beacon.status, 202);
    const bad = await api(`/sessions/${sid}/events`, { method: "POST", body: { events: [{ tipo: "hack" }] } });
    assert.equal(bad.status, 400);
    const missing = await api(`/sessions/${crypto.randomUUID()}/events`, { method: "POST", body: { events: [] } });
    assert.equal(missing.status, 404);
    const [s] = await sql`SELECT scroll_max, tempo_total, paginas, ultima_secao FROM visitor_sessions WHERE id = ${sid}`;
    assert.deepEqual(s, { scroll_max: 75, tempo_total: 50, paginas: 1, ultima_secao: "cases" });
});

test("conversão de WhatsApp é idempotente por event_id", async () => {
    const body = { tipo: "whatsapp_click", event_id: "test-wa-1", session_id: sid, rotulo: "contato", pagina: "https://push.test/" };
    const a = await api("/conversoes", { method: "POST", body });
    assert.equal(a.status, 201);
    assert.equal(a.body.capi, "pendente"); // consentiu → vai para a CAPI (desativada no teste)
    const b = await api("/conversoes", { method: "POST", body });
    assert.equal(b.status, 200);
    await new Promise((r) => setTimeout(r, 100));
    const [c] = await sql`SELECT capi_status FROM conversoes WHERE event_id = 'test-wa-1'`;
    assert.equal(c.capi_status, "desativado");
    const [s] = await sql`SELECT convertido FROM visitor_sessions WHERE id = ${sid}`;
    assert.equal(s.convertido, true);
});

let leadId;
test("lead: validação, honeypot, criação e dedupe", async () => {
    const base = {
        nome: "Maria da Silva",
        whatsapp: "(51) 99999-8888",
        email: "Maria@Exemplo.com",
        empresa: "@loja",
        servicos: ["site_landing", "trafego_pago"],
        investimento: "2k_5k",
        consentimento: true,
        event_id: "test-lead-1",
        session_id: sid,
        pagina_origem: "https://push.test/#contato",
        elapsed_ms: 20000,
    };
    assert.equal((await api("/leads", { method: "POST", body: { ...base, whatsapp: "123" } })).status, 400);
    assert.equal((await api("/leads", { method: "POST", body: { ...base, consentimento: false } })).status, 400);
    const hp = await api("/leads", { method: "POST", body: { ...base, website: "http://spam", event_id: "test-hp" } });
    assert.equal(hp.status, 201);
    assert.equal((await sql`SELECT 1 FROM leads WHERE event_id = 'test-hp'`).length, 0);

    const ok = await api("/leads", { method: "POST", body: base });
    assert.equal(ok.status, 201);
    leadId = ok.body.id;
    const again = await api("/leads", { method: "POST", body: base });
    assert.equal(again.body.id, leadId);

    const [l] = await sql`SELECT * FROM leads WHERE id = ${leadId}`;
    assert.equal(l.whatsapp, "5551999998888");
    assert.equal(l.email, "maria@exemplo.com");
    assert.equal(l.utm_campaign, "push-leads-set"); // herdado da sessão
    assert.equal(l.ft_utm_source, "meta");
    const [c] = await sql`SELECT tipo, capi_evento, lead_id FROM conversoes WHERE event_id = 'test-lead-1'`;
    assert.deepEqual(c, { tipo: "lead_form", capi_evento: "Lead", lead_id: leadId });
});

test("painel: lista, detalhe com jornada, status, notas, tags, CSV", async () => {
    const list = await api("/leads?range=7d&q=maria", { auth: true });
    assert.equal(list.status, 200);
    assert.ok(list.body.items.some((l) => l.id === leadId));

    const patched = await api(`/leads/${leadId}`, { method: "PATCH", auth: true, body: { status: "em_contato" } });
    assert.equal(patched.body.status, "em_contato");

    const note = await api(`/leads/${leadId}/notes`, { method: "POST", auth: true, body: { texto: "Ligar amanhã" } });
    assert.equal(note.status, 201);

    const [tag] = await sql`SELECT id FROM tags LIMIT 1`;
    const tagged = await api(`/leads/${leadId}/tags`, { method: "POST", auth: true, body: { tag_id: tag.id } });
    assert.equal(tagged.body.tags.length, 1);

    const detail = await api(`/leads/${leadId}`, { auth: true });
    assert.equal(detail.status, 200);
    assert.ok(detail.body.jornada.events.length >= 7);
    assert.equal(detail.body.jornada.visitas_ate_converter, 2);
    assert.equal(detail.body.notas.length, 2); // nota + registro de status

    const csv = await api(`/leads/export.csv?range=7d&status=em_contato`, { auth: true });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-type"), /text\/csv/);
    assert.match(csv.body, /Maria da Silva/);
});

test("painel: overview, sessões, conversões, campanhas", async () => {
    const camp = await api("/campaigns", {
        method: "POST",
        auth: true,
        body: { nome: "Leads Setembro", utm_campaign: "push-leads-set-test", investimento: 1500 },
    });
    assert.equal(camp.status, 201);
    await sql`UPDATE leads SET utm_campaign = 'push-leads-set-test' WHERE id = ${leadId}`;

    const o = await api("/dashboard/overview?range=7d", { auth: true });
    assert.equal(o.status, 200);
    assert.ok(o.body.kpis.sessoes >= 2);
    assert.ok(o.body.kpis.leads >= 1);
    assert.ok(o.body.kpis.cpl > 0);
    assert.equal(o.body.serie.length, 7);
    assert.equal(o.body.funil.length, 5);
    assert.ok(o.body.campanhas.some((c) => c.campanha === "push-leads-set-test" && c.cpl === 1500));

    const s = await api(`/sessions?range=7d&convertido=true`, { auth: true });
    assert.ok(s.body.items.some((x) => x.id === sid));
    const sd = await api(`/sessions/${sid}`, { auth: true });
    assert.equal(sd.body.session.id, sid);
    assert.equal(sd.body.session.ip_hash, undefined);

    const c = await api(`/conversoes?range=7d`, { auth: true });
    assert.ok(c.body.items.length >= 2);

    await api(`/campaigns/${camp.body.id}`, { method: "DELETE", auth: true });
});

test("usuários: só admin, senha mínima", async () => {
    const weak = await api("/users", { method: "POST", auth: true, body: { username: "joao", password: "123" } });
    assert.equal(weak.status, 400);
    const created = await api("/users", { method: "POST", auth: true, body: { username: "joao.test", password: "senha-forte-123" } });
    assert.equal(created.status, 201);
    await api(`/users/${created.body.id}`, { method: "DELETE", auth: true });
});
