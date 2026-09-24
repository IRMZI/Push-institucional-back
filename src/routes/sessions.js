const express = require("express");
const sql = require("../db");
const { requireAuth } = require("../middlewares/auth");
const { trackingLimiter } = require("../middlewares/limits");
const { z, optStr, uuid, isUuid, bodyObject, parse, parsePeriod, pagination, intId } = require("../lib/validation");
const { ipHash } = require("../lib/request");
const { EVENT_TIPOS } = require("../lib/constants");
const { inPeriod, sourceExpr, tagsJson } = require("../lib/sqlHelpers");
const { config } = require("../config");

const router = express.Router();

const utmShape = {
    utm_source: optStr(),
    utm_medium: optStr(),
    utm_campaign: optStr(),
    utm_content: optStr(),
    utm_term: optStr(),
    fbclid: optStr(500),
    gclid: optStr(500),
};
const utmSchema = z.object(utmShape).partial().default({});

const sessionSchema = z.object({
    id: uuid,
    visit_id: uuid.optional(),
    landing_page: optStr(500),
    referrer: optStr(500),
    dispositivo: z.enum(["mobile", "tablet", "desktop"]).optional().nullable(),
    browser: optStr(60),
    os: optStr(60),
    idioma: optStr(20),
    resolucao: optStr(20),
    viewport: optStr(20),
    utm: utmSchema,
    first_touch: z
        .object({ ...utmShape, referrer: optStr(500), landing_page: optStr(500), ts: z.number().int().positive() })
        .partial()
        .optional(),
    consentimento: z.enum(["all", "essential"]).optional().nullable(),
});

const clampTs = (ts) => {
    const now = Date.now();
    if (typeof ts !== "number" || ts > now + 60_000 || ts < now - 24 * 3600_000) return new Date(now);
    return new Date(ts);
};

// POST /api/sessions — cria ou atualiza a sessão do visitante (público)
router.post("/", trackingLimiter, async (req, res) => {
    const b = parse(sessionSchema, bodyObject(req), res);
    if (!b) return;

    const u = b.utm || {};
    const ft = b.first_touch || {};
    const hasCampaign = Boolean(u.utm_source || u.utm_campaign || u.utm_medium || u.fbclid || u.gclid);
    const ft_em = ft.ts ? clampTs(ft.ts) : new Date();

    try {
        await sql.begin(async (tx) => {
            await tx`
              INSERT INTO visitor_sessions (
                id, landing_page, referrer, dispositivo, browser, os, idioma, resolucao, viewport,
                user_agent, ip_hash,
                utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid, gclid,
                ft_utm_source, ft_utm_medium, ft_utm_campaign, ft_utm_content, ft_utm_term,
                ft_fbclid, ft_gclid, ft_referrer, ft_landing_page, ft_em,
                consentimento, consentimento_em
              ) VALUES (
                ${b.id}, ${b.landing_page}, ${b.referrer}, ${b.dispositivo ?? null}, ${b.browser}, ${b.os},
                ${b.idioma}, ${b.resolucao}, ${b.viewport}, ${(req.get("user-agent") || "").slice(0, 500) || null}, ${ipHash(req)},
                ${u.utm_source ?? null}, ${u.utm_medium ?? null}, ${u.utm_campaign ?? null}, ${u.utm_content ?? null},
                ${u.utm_term ?? null}, ${u.fbclid ?? null}, ${u.gclid ?? null},
                ${ft.utm_source ?? u.utm_source ?? null}, ${ft.utm_medium ?? u.utm_medium ?? null},
                ${ft.utm_campaign ?? u.utm_campaign ?? null}, ${ft.utm_content ?? u.utm_content ?? null},
                ${ft.utm_term ?? u.utm_term ?? null}, ${ft.fbclid ?? u.fbclid ?? null}, ${ft.gclid ?? u.gclid ?? null},
                ${ft.referrer ?? b.referrer}, ${ft.landing_page ?? b.landing_page}, ${ft_em},
                ${b.consentimento ?? null}, ${b.consentimento ? new Date() : null}
              )
              ON CONFLICT (id) DO UPDATE SET
                ultimo_acesso = NOW(),
                dispositivo = COALESCE(EXCLUDED.dispositivo, visitor_sessions.dispositivo),
                browser = COALESCE(EXCLUDED.browser, visitor_sessions.browser),
                os = COALESCE(EXCLUDED.os, visitor_sessions.os),
                viewport = COALESCE(EXCLUDED.viewport, visitor_sessions.viewport),
                user_agent = COALESCE(EXCLUDED.user_agent, visitor_sessions.user_agent),
                ip_hash = COALESCE(EXCLUDED.ip_hash, visitor_sessions.ip_hash),
                -- last-touch: só troca quando a visita atual trouxe parâmetros de campanha
                utm_source   = CASE WHEN ${hasCampaign} THEN EXCLUDED.utm_source   ELSE visitor_sessions.utm_source END,
                utm_medium   = CASE WHEN ${hasCampaign} THEN EXCLUDED.utm_medium   ELSE visitor_sessions.utm_medium END,
                utm_campaign = CASE WHEN ${hasCampaign} THEN EXCLUDED.utm_campaign ELSE visitor_sessions.utm_campaign END,
                utm_content  = CASE WHEN ${hasCampaign} THEN EXCLUDED.utm_content  ELSE visitor_sessions.utm_content END,
                utm_term     = CASE WHEN ${hasCampaign} THEN EXCLUDED.utm_term     ELSE visitor_sessions.utm_term END,
                fbclid       = CASE WHEN ${hasCampaign} THEN EXCLUDED.fbclid       ELSE visitor_sessions.fbclid END,
                gclid        = CASE WHEN ${hasCampaign} THEN EXCLUDED.gclid        ELSE visitor_sessions.gclid END,
                referrer     = COALESCE(EXCLUDED.referrer, visitor_sessions.referrer),
                landing_page = CASE WHEN ${Boolean(b.visit_id)} THEN COALESCE(EXCLUDED.landing_page, visitor_sessions.landing_page) ELSE visitor_sessions.landing_page END,
                consentimento = COALESCE(EXCLUDED.consentimento, visitor_sessions.consentimento),
                consentimento_em = CASE
                  WHEN EXCLUDED.consentimento IS NOT NULL AND EXCLUDED.consentimento IS DISTINCT FROM visitor_sessions.consentimento
                  THEN NOW() ELSE visitor_sessions.consentimento_em END`;

            if (b.visit_id) {
                const host = b.referrer ? /^https?:\/\/(?:www\.)?([^/:?#]+)/i.exec(b.referrer)?.[1] ?? null : null;
                const inserted = await tx`
                  INSERT INTO session_events (session_id, visit_id, tipo, pagina, dados)
                  VALUES (${b.id}, ${b.visit_id}, 'visit_start', ${b.landing_page}, ${tx.json({
                      utm_source: u.utm_source ?? null,
                      utm_medium: u.utm_medium ?? null,
                      utm_campaign: u.utm_campaign ?? null,
                      referrer_host: host,
                      dispositivo: b.dispositivo ?? null,
                  })})
                  ON CONFLICT (visit_id) WHERE tipo = 'visit_start' DO NOTHING
                  RETURNING id`;
                if (inserted.length > 0) {
                    await tx`UPDATE visitor_sessions SET visitas = visitas + 1 WHERE id = ${b.id}`;
                }
            }
        });
        res.status(201).json({ ok: true });
    } catch (err) {
        console.error("Erro ao salvar sessão:", err);
        res.status(500).json({ error: "Erro interno." });
    }
});

const eventSchema = z.object({
    tipo: z.enum(EVENT_TIPOS),
    nome: optStr(120),
    pagina: optStr(500),
    valor: z.number().int().min(0).max(86400).optional().nullable(),
    dados: z.record(z.string(), z.union([z.string().max(300), z.number(), z.boolean(), z.null()])).optional().nullable(),
    ts: z.number().int().optional(),
});

const eventsBatchSchema = z.object({
    visit_id: uuid.optional(),
    events: z.array(eventSchema).max(60).default([]),
    // segundos de engajamento (aba visível) desde o último lote
    engaged_seconds: z.number().int().min(0).max(1800).optional(),
});

// POST /api/sessions/:id/events — eventos em lote (público; aceita sendBeacon text/plain)
router.post("/:id/events", trackingLimiter, async (req, res) => {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(400).json({ error: "ID inválido." });
    const b = parse(eventsBatchSchema, bodyObject(req), res);
    if (!b) return;

    try {
        const exists = await sql`SELECT 1 FROM visitor_sessions WHERE id = ${id}`;
        if (exists.length === 0) return res.status(404).json({ error: "Sessão não encontrada.", recreate: true });

        if (b.events.length > 0) {
            const rows = b.events.map((e) => ({
                session_id: id,
                visit_id: b.visit_id ?? null,
                tipo: e.tipo,
                nome: e.nome ?? null,
                pagina: e.pagina ?? null,
                valor: e.valor ?? null,
                dados: e.dados ? sql.json(e.dados) : null,
                ocorrido_em: clampTs(e.ts),
            }));
            await sql`INSERT INTO session_events ${sql(rows, "session_id", "visit_id", "tipo", "nome", "pagina", "valor", "dados", "ocorrido_em")}`;
        }

        const scroll = Math.max(0, ...b.events.filter((e) => e.tipo === "scroll_depth").map((e) => e.valor || 0));
        const pageViews = b.events.filter((e) => e.tipo === "page_view").length;
        const lastSection = [...b.events].reverse().find((e) => e.tipo === "section_view")?.nome ?? null;
        await sql`
          UPDATE visitor_sessions SET
            ultimo_acesso = NOW(),
            scroll_max = GREATEST(scroll_max, ${Math.min(scroll, 100)}),
            tempo_total = tempo_total + ${b.engaged_seconds || 0},
            paginas = paginas + ${pageViews},
            ultima_secao = COALESCE(${lastSection}, ultima_secao)
          WHERE id = ${id}`;

        res.status(202).json({ ok: true, recebidos: b.events.length });
    } catch (err) {
        console.error("Erro ao salvar eventos:", err);
        res.status(500).json({ error: "Erro interno." });
    }
});

// ---------- Rotas autenticadas (painel) ----------

// GET /api/sessions — lista com filtros
router.get("/", requireAuth, async (req, res) => {
    const period = parsePeriod(req.query, config.timezone);
    const { limit, offset, page } = pagination(req.query);
    const tagId = intId(req.query.tag);
    const convertido = req.query.convertido === "true" ? true : req.query.convertido === "false" ? false : null;
    const dispositivo = ["mobile", "tablet", "desktop"].includes(req.query.dispositivo) ? req.query.dispositivo : null;
    const origem = typeof req.query.origem === "string" && req.query.origem.trim() ? req.query.origem.trim().toLowerCase() : null;
    const q = typeof req.query.q === "string" && req.query.q.trim() ? `%${req.query.q.trim().slice(0, 80)}%` : null;

    const where = sql`
      WHERE ${inPeriod("vs.ultimo_acesso", period)}
      ${convertido === null ? sql`` : sql`AND vs.convertido = ${convertido}`}
      ${dispositivo ? sql`AND vs.dispositivo = ${dispositivo}` : sql``}
      ${origem ? sql`AND ${sourceExpr("vs")} = ${origem}` : sql``}
      ${tagId ? sql`AND EXISTS (SELECT 1 FROM session_tags st WHERE st.session_id = vs.id AND st.tag_id = ${tagId})` : sql``}
      ${q ? sql`AND (vs.id::text ILIKE ${q} OR l.nome ILIKE ${q} OR vs.utm_campaign ILIKE ${q})` : sql``}`;

    try {
        const [items, total] = await Promise.all([
            sql`
              SELECT vs.id, vs.criado_em, vs.ultimo_acesso, vs.visitas, vs.dispositivo, vs.browser, vs.os,
                vs.landing_page, vs.utm_source, vs.utm_medium, vs.utm_campaign, vs.referrer,
                ${sourceExpr("vs")} AS origem,
                vs.tempo_total, vs.paginas, vs.scroll_max, vs.ultima_secao, vs.convertido, vs.convertido_em,
                vs.consentimento, vs.lead_id, l.nome AS lead_nome,
                (SELECT COUNT(*)::int FROM conversoes c WHERE c.session_id = vs.id) AS conversoes,
                ${tagsJson("session_tags", "session_id", "vs.id")} AS tags
              FROM visitor_sessions vs
              LEFT JOIN leads l ON l.id = vs.lead_id AND l.deletado_em IS NULL
              ${where}
              ORDER BY vs.ultimo_acesso DESC
              LIMIT ${limit} OFFSET ${offset}`,
            sql`SELECT COUNT(*)::int AS n FROM visitor_sessions vs LEFT JOIN leads l ON l.id = vs.lead_id ${where}`,
        ]);
        res.json({ items, total: total[0].n, page, limit });
    } catch (err) {
        console.error("Erro ao listar sessões:", err);
        res.status(500).json({ error: "Erro interno." });
    }
});

// Linha do tempo completa de uma sessão (usada também no detalhe do lead)
async function sessionJourney(id) {
    const rows = await sql`
      SELECT vs.*, ${sourceExpr("vs")} AS origem,
        ${tagsJson("session_tags", "session_id", "vs.id")} AS tags
      FROM visitor_sessions vs WHERE vs.id = ${id}`;
    if (rows.length === 0) return null;
    const session = rows[0];
    delete session.ip_hash;
    const [events, conversoes, leads] = await Promise.all([
        sql`
          SELECT id, visit_id, tipo, nome, pagina, valor, dados, ocorrido_em
          FROM session_events WHERE session_id = ${id}
          ORDER BY ocorrido_em, id LIMIT 2000`,
        sql`
          SELECT id, event_id, tipo, rotulo, pagina, destino, lead_id, criado_em, capi_evento, capi_status
          FROM conversoes WHERE session_id = ${id} ORDER BY criado_em`,
        sql`SELECT id, nome, status, criado_em FROM leads WHERE session_id = ${id} AND deletado_em IS NULL ORDER BY criado_em`,
    ]);
    return { session, events, conversoes, leads };
}

// GET /api/sessions/:id — detalhe com jornada
router.get("/:id", requireAuth, async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: "ID inválido." });
    try {
        const journey = await sessionJourney(req.params.id);
        if (!journey) return res.status(404).json({ error: "Sessão não encontrada." });
        res.json(journey);
    } catch (err) {
        console.error("Erro ao buscar sessão:", err);
        res.status(500).json({ error: "Erro interno." });
    }
});

const tagsOf = (id) => sql`
  SELECT t.id, t.nome, t.cor FROM session_tags st JOIN tags t ON t.id = st.tag_id
  WHERE st.session_id = ${id} ORDER BY t.nome`;

// POST /api/sessions/:id/tags { tag_id }
router.post("/:id/tags", requireAuth, async (req, res) => {
    const tagId = intId(req.body?.tag_id);
    if (!isUuid(req.params.id) || !tagId) return res.status(400).json({ error: "Dados inválidos." });
    try {
        const r = await sql`
          INSERT INTO session_tags (session_id, tag_id)
          SELECT ${req.params.id}, ${tagId}
          WHERE EXISTS (SELECT 1 FROM visitor_sessions WHERE id = ${req.params.id})
            AND EXISTS (SELECT 1 FROM tags WHERE id = ${tagId})
          ON CONFLICT DO NOTHING RETURNING tag_id`;
        const tags = await tagsOf(req.params.id);
        if (r.length === 0 && !tags.some((t) => t.id === tagId)) return res.status(404).json({ error: "Sessão ou tag não encontrada." });
        res.json({ tags });
    } catch (err) {
        console.error("Erro ao vincular tag:", err);
        res.status(500).json({ error: "Erro interno." });
    }
});

// DELETE /api/sessions/:id/tags/:tagId
router.delete("/:id/tags/:tagId", requireAuth, async (req, res) => {
    const tagId = intId(req.params.tagId);
    if (!isUuid(req.params.id) || !tagId) return res.status(400).json({ error: "Dados inválidos." });
    try {
        await sql`DELETE FROM session_tags WHERE session_id = ${req.params.id} AND tag_id = ${tagId}`;
        res.json({ tags: await tagsOf(req.params.id) });
    } catch (err) {
        console.error("Erro ao remover tag:", err);
        res.status(500).json({ error: "Erro interno." });
    }
});

module.exports = router;
module.exports.sessionJourney = sessionJourney;
