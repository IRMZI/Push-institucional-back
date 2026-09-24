const express = require("express");
const sql = require("../db");
const { config } = require("../config");
const { requireAuth } = require("../middlewares/auth");
const { conversionLimiter } = require("../middlewares/limits");
const { z, optStr, uuid, bodyObject, parse, parsePeriod, pagination, intId } = require("../lib/validation");
const { CONVERSAO_TIPOS } = require("../lib/constants");
const { registerConversion } = require("../lib/conversions");
const { buildEvent, sendForConversion } = require("../lib/metaCapi");
const { inPeriod } = require("../lib/sqlHelpers");

const router = express.Router();

const schema = z.object({
    tipo: z.enum(CONVERSAO_TIPOS.filter((t) => t !== "lead_form")), // lead_form só via POST /api/leads
    event_id: z.string().trim().min(8).max(80).regex(/^[\w.:-]+$/),
    session_id: uuid.optional().nullable(),
    rotulo: optStr(120),
    pagina: optStr(500),
    destino: optStr(500),
    fbp: optStr(255),
    fbc: optStr(500),
    fbclid: optStr(500),
    consentimento: z.enum(["all", "essential"]).optional().nullable(),
});

// POST /api/conversoes — clique de WhatsApp/Instagram/e-mail/CTA (público)
router.post("/", conversionLimiter, async (req, res) => {
    const b = parse(schema, bodyObject(req), res);
    if (!b) return;
    try {
        const { conversao, duplicate } = await registerConversion(req, {
            tipo: b.tipo,
            eventId: b.event_id,
            sessionId: b.session_id,
            rotulo: b.rotulo,
            pagina: b.pagina,
            destino: b.destino,
            fbp: b.fbp,
            fbc: b.fbc,
            fbclid: b.fbclid,
            consentimento: b.consentimento,
        });
        res.status(duplicate ? 200 : 201).json({ ok: true, id: conversao.id, capi: conversao.capi_status });
    } catch (err) {
        console.error("Erro ao registrar conversão:", err);
        res.status(500).json({ error: "Erro interno." });
    }
});

// GET /api/conversoes — lista (painel)
router.get("/", requireAuth, async (req, res) => {
    const period = parsePeriod(req.query, config.timezone);
    const { limit, offset, page } = pagination(req.query);
    const tipo = CONVERSAO_TIPOS.includes(req.query.tipo) ? req.query.tipo : null;
    const capi = typeof req.query.capi_status === "string" && /^[a-z_]{3,20}$/.test(req.query.capi_status) ? req.query.capi_status : null;

    const where = sql`
      WHERE ${inPeriod("c.criado_em", period)}
      ${tipo ? sql`AND c.tipo = ${tipo}` : sql``}
      ${capi ? sql`AND c.capi_status = ${capi}` : sql``}`;
    try {
        const [items, total, resumo] = await Promise.all([
            sql`
              SELECT c.id, c.event_id, c.tipo, c.rotulo, c.pagina, c.destino, c.criado_em,
                c.session_id, c.lead_id, l.nome AS lead_nome,
                vs.utm_source, vs.utm_campaign, vs.dispositivo,
                c.capi_evento, c.capi_status, c.capi_resposta, c.capi_tentativas, c.capi_enviado_em
              FROM conversoes c
              LEFT JOIN leads l ON l.id = c.lead_id
              LEFT JOIN visitor_sessions vs ON vs.id = c.session_id
              ${where}
              ORDER BY c.criado_em DESC LIMIT ${limit} OFFSET ${offset}`,
            sql`SELECT COUNT(*)::int AS n FROM conversoes c ${where}`,
            sql`SELECT c.tipo, COUNT(*)::int AS total FROM conversoes c WHERE ${inPeriod("c.criado_em", period)} GROUP BY c.tipo`,
        ]);
        res.json({ items, total: total[0].n, page, limit, resumo });
    } catch (err) {
        console.error("Erro ao listar conversões:", err);
        res.status(500).json({ error: "Erro interno." });
    }
});

// POST /api/conversoes/:id/reenviar — reenvia um evento com erro para a CAPI (painel)
router.post("/:id/reenviar", requireAuth, async (req, res) => {
    const id = intId(req.params.id);
    if (!id) return res.status(400).json({ error: "ID inválido." });
    try {
        const rows = await sql`
          SELECT c.*, vs.fbclid AS session_fbclid,
            l.nome, l.email, l.whatsapp, l.servicos
          FROM conversoes c
          LEFT JOIN visitor_sessions vs ON vs.id = c.session_id
          LEFT JOIN leads l ON l.id = c.lead_id
          WHERE c.id = ${id}`;
        const c = rows[0];
        if (!c) return res.status(404).json({ error: "Conversão não encontrada." });
        if (!c.capi_evento) return res.status(400).json({ error: "Esta conversão não é enviada à CAPI." });
        if (c.capi_status === "sem_consentimento") return res.status(400).json({ error: "Visitante não consentiu com cookies de mídia." });

        const event = buildEvent({
            eventName: c.capi_evento,
            eventId: c.event_id,
            eventTime: new Date(c.criado_em).getTime(),
            sourceUrl: c.pagina,
            ua: c.user_agent,
            fbp: c.fbp,
            fbc: c.fbc,
            fbclid: c.session_fbclid,
            sessionId: c.session_id,
            lead: c.lead_id ? { nome: c.nome, email: c.email, whatsapp: c.whatsapp, servicos: c.servicos } : null,
        });
        const result = await sendForConversion(c.id, event);
        res.json(result);
    } catch (err) {
        console.error("Erro ao reenviar conversão:", err);
        res.status(500).json({ error: "Erro interno." });
    }
});

module.exports = router;
