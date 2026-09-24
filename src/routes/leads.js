const express = require("express");
const sql = require("../db");
const { config } = require("../config");
const { requireAuth } = require("../middlewares/auth");
const { leadLimiter } = require("../middlewares/limits");
const { z, optStr, uuid, parse, parsePeriod, pagination, intId } = require("../lib/validation");
const { LEAD_STATUS, LEAD_STATUS_KEYS, SERVICOS, INVESTIMENTOS, SERVICO_LABEL, INVESTIMENTO_LABEL } = require("../lib/constants");
const { toE164BR } = require("../lib/phone");
const { registerConversion } = require("../lib/conversions");
const { notifyNewLead } = require("../lib/notify");
const { inPeriod, sourceExpr, tagsJson } = require("../lib/sqlHelpers");
const { sessionJourney } = require("./sessions");

const router = express.Router();

const leadSchema = z.object({
    nome: z.string().trim().min(2, "Informe seu nome.").max(120),
    whatsapp: z.string().trim().min(8).max(30),
    email: z
        .union([z.literal(""), z.string().trim().toLowerCase().max(255).email("E-mail inválido.")])
        .optional()
        .nullable()
        .transform((v) => v || null),
    empresa: optStr(160),
    servicos: z.array(z.enum(SERVICOS)).max(4).default([]),
    investimento: z.enum(INVESTIMENTOS).optional().nullable(),
    mensagem: optStr(2000),
    consentimento: z.literal(true, { message: "É preciso aceitar a Política de Privacidade." }),
    // honeypot: campo invisível que humanos deixam vazio
    website: z.string().max(200).optional().nullable(),
    // tempo (ms) entre abrir o formulário e enviar — bots enviam instantaneamente
    elapsed_ms: z.number().int().min(0).optional(),
    // ocultos
    event_id: z.string().trim().min(8).max(80).regex(/^[\w.:-]+$/),
    session_id: uuid.optional().nullable(),
    pagina_origem: optStr(500),
    referrer: optStr(500),
    utm: z
        .object({
            utm_source: optStr(),
            utm_medium: optStr(),
            utm_campaign: optStr(),
            utm_content: optStr(),
            utm_term: optStr(),
        })
        .partial()
        .default({}),
    first_touch: z
        .object({ utm_source: optStr(), utm_medium: optStr(), utm_campaign: optStr(), utm_content: optStr(), utm_term: optStr() })
        .partial()
        .default({}),
    fbclid: optStr(500),
    gclid: optStr(500),
    fbp: optStr(255),
    fbc: optStr(500),
    consentimento_cookies: z.enum(["all", "essential"]).optional().nullable(),
});

// POST /api/leads — formulário do site (público)
router.post("/", leadLimiter, async (req, res) => {
    // Honeypot preenchido ou envio instantâneo: responde "sucesso" sem gravar nada
    if ((req.body?.website && String(req.body.website).trim()) || (typeof req.body?.elapsed_ms === "number" && req.body.elapsed_ms < 1500)) {
        return res.status(201).json({ ok: true });
    }
    const b = parse(leadSchema, req.body, res);
    if (!b) return;

    const whatsapp = toE164BR(b.whatsapp);
    if (!whatsapp) return res.status(400).json({ error: "Número de WhatsApp inválido.", campo: "whatsapp" });

    try {
        // Duplo envio (duplo clique / retry): mesmo event_id devolve o lead já criado
        const dup = await sql`SELECT id FROM leads WHERE event_id = ${b.event_id} LIMIT 1`;
        if (dup.length > 0) return res.status(200).json({ ok: true, id: dup[0].id });

        // UTMs: o que o navegador mandou, completado com a sessão registrada
        let session = null;
        if (b.session_id) {
            const rows = await sql`SELECT * FROM visitor_sessions WHERE id = ${b.session_id}`;
            session = rows[0] || null;
        }
        const lt = (k) => b.utm[k] ?? session?.[k] ?? null;
        const ft = (k) => b.first_touch[k] ?? session?.[`ft_${k}`] ?? null;

        const inserted = await sql`
          INSERT INTO leads (
            nome, whatsapp, email, empresa, servicos, investimento, mensagem,
            consentimento, consentimento_em, session_id, event_id, pagina_origem, referrer,
            utm_source, utm_medium, utm_campaign, utm_content, utm_term,
            ft_utm_source, ft_utm_medium, ft_utm_campaign, ft_utm_content, ft_utm_term,
            fbclid, gclid, user_agent
          ) VALUES (
            ${b.nome}, ${whatsapp}, ${b.email}, ${b.empresa}, ${b.servicos}, ${b.investimento ?? null}, ${b.mensagem},
            true, NOW(), ${session ? session.id : null}, ${b.event_id}, ${b.pagina_origem}, ${b.referrer ?? session?.referrer ?? null},
            ${lt("utm_source")}, ${lt("utm_medium")}, ${lt("utm_campaign")}, ${lt("utm_content")}, ${lt("utm_term")},
            ${ft("utm_source")}, ${ft("utm_medium")}, ${ft("utm_campaign")}, ${ft("utm_content")}, ${ft("utm_term")},
            ${b.fbclid ?? session?.fbclid ?? null}, ${b.gclid ?? session?.gclid ?? null},
            ${(req.get("user-agent") || "").slice(0, 500) || null}
          ) RETURNING *`;
        const lead = inserted[0];

        await registerConversion(req, {
            tipo: "lead_form",
            eventId: b.event_id,
            sessionId: lead.session_id,
            lead,
            rotulo: "formulario-contato",
            pagina: b.pagina_origem,
            fbp: b.fbp,
            fbc: b.fbc,
            fbclid: lead.fbclid,
            consentimento: b.consentimento_cookies,
        });

        notifyNewLead(lead);
        res.status(201).json({ ok: true, id: lead.id });
    } catch (err) {
        console.error("Erro ao salvar lead:", err);
        res.status(500).json({ error: "Não conseguimos enviar agora. Tente novamente ou fale pelo WhatsApp." });
    }
});

// ---------- Painel ----------

// Filtros compartilhados pela lista e pela exportação CSV
function leadFilters(query) {
    const period = parsePeriod(query, config.timezone);
    const status = LEAD_STATUS_KEYS.includes(query.status) ? query.status : null;
    const servico = SERVICOS.includes(query.servico) ? query.servico : null;
    const investimento = INVESTIMENTOS.includes(query.investimento) ? query.investimento : null;
    const origem = typeof query.origem === "string" && query.origem.trim() ? query.origem.trim().toLowerCase().slice(0, 120) : null;
    const campanha = typeof query.campanha === "string" && query.campanha.trim() ? query.campanha.trim().slice(0, 255) : null;
    const tagId = intId(query.tag);
    const q = typeof query.q === "string" && query.q.trim() ? query.q.trim().slice(0, 100) : null;
    const qDigits = q ? q.replace(/\D/g, "") : "";

    return sql`
      WHERE l.deletado_em IS NULL
        AND ${inPeriod("l.criado_em", period)}
        ${status ? sql`AND l.status = ${status}` : sql``}
        ${servico ? sql`AND ${servico} = ANY(l.servicos)` : sql``}
        ${investimento ? sql`AND l.investimento = ${investimento}` : sql``}
        ${origem ? sql`AND ${sourceExpr("l")} = ${origem}` : sql``}
        ${campanha ? sql`AND l.utm_campaign = ${campanha}` : sql``}
        ${tagId ? sql`AND EXISTS (SELECT 1 FROM lead_tags lt WHERE lt.lead_id = l.id AND lt.tag_id = ${tagId})` : sql``}
        ${
            q
                ? sql`AND (l.nome ILIKE ${"%" + q + "%"} OR l.email ILIKE ${"%" + q + "%"} OR l.empresa ILIKE ${"%" + q + "%"}
                     ${qDigits.length >= 4 ? sql`OR l.whatsapp LIKE ${"%" + qDigits + "%"}` : sql``})`
                : sql``
        }`;
}

// GET /api/leads — lista
router.get("/", requireAuth, async (req, res) => {
    const { limit, offset, page } = pagination(req.query, 500);
    const where = leadFilters(req.query);
    try {
        const [items, total, porStatus] = await Promise.all([
            sql`
              SELECT l.id, l.nome, l.whatsapp, l.email, l.empresa, l.servicos, l.investimento, l.status,
                l.criado_em, l.status_alterado_em, l.utm_source, l.utm_campaign, l.session_id,
                ${sourceExpr("l")} AS origem,
                (SELECT COUNT(*)::int FROM lead_notes n WHERE n.lead_id = l.id) AS notas,
                ${tagsJson("lead_tags", "lead_id", "l.id")} AS tags
              FROM leads l ${where}
              ORDER BY l.criado_em DESC LIMIT ${limit} OFFSET ${offset}`,
            sql`SELECT COUNT(*)::int AS n FROM leads l ${where}`,
            sql`SELECT l.status, COUNT(*)::int AS total FROM leads l ${where} GROUP BY l.status`,
        ]);
        res.json({ items, total: total[0].n, page, limit, por_status: porStatus, status: LEAD_STATUS });
    } catch (err) {
        console.error("Erro ao listar leads:", err);
        res.status(500).json({ error: "Erro interno." });
    }
});

const csvCell = (v) => {
    if (v === null || v === undefined) return "";
    let s = Array.isArray(v) ? v.join(" | ") : v instanceof Date ? v.toISOString() : String(v);
    // Evita injeção de fórmula ao abrir no Excel/Sheets
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// GET /api/leads/export.csv — exportação respeitando os filtros
router.get("/export.csv", requireAuth, async (req, res) => {
    try {
        const rows = await sql`
          SELECT l.id, l.criado_em, l.nome, l.whatsapp, l.email, l.empresa, l.servicos, l.investimento, l.status,
            l.mensagem, ${sourceExpr("l")} AS origem, l.utm_source, l.utm_medium, l.utm_campaign, l.utm_content, l.utm_term,
            l.ft_utm_source, l.ft_utm_campaign, l.pagina_origem,
            (SELECT string_agg(t.nome, ', ' ORDER BY t.nome) FROM lead_tags lt JOIN tags t ON t.id = lt.tag_id WHERE lt.lead_id = l.id) AS tags
          FROM leads l ${leadFilters(req.query)}
          ORDER BY l.criado_em DESC LIMIT 10000`;
        const statusLabel = Object.fromEntries(LEAD_STATUS.map((s) => [s.key, s.label]));
        const header = [
            "ID", "Data", "Nome", "WhatsApp", "E-mail", "Empresa/Instagram", "Serviços", "Investimento", "Status",
            "Mensagem", "Origem", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
            "first_utm_source", "first_utm_campaign", "Página", "Tags",
        ];
        const lines = rows.map((r) =>
            [
                r.id,
                new Date(r.criado_em).toLocaleString("pt-BR", { timeZone: config.timezone }),
                r.nome,
                `+${r.whatsapp}`,
                r.email,
                r.empresa,
                (r.servicos || []).map((s) => SERVICO_LABEL[s] || s),
                INVESTIMENTO_LABEL[r.investimento] || r.investimento,
                statusLabel[r.status] || r.status,
                r.mensagem,
                r.origem,
                r.utm_source, r.utm_medium, r.utm_campaign, r.utm_content, r.utm_term,
                r.ft_utm_source, r.ft_utm_campaign, r.pagina_origem, r.tags,
            ]
                .map(csvCell)
                .join(";")
        );
        const stamp = new Date().toISOString().slice(0, 10);
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="leads-push-${stamp}.csv"`);
        // BOM para o Excel reconhecer UTF-8; ";" como separador (padrão pt-BR)
        res.send("﻿" + [header.join(";"), ...lines].join("\r\n"));
    } catch (err) {
        console.error("Erro ao exportar leads:", err);
        res.status(500).json({ error: "Erro interno." });
    }
});

async function leadDetail(id) {
    const rows = await sql`
      SELECT l.*, ${sourceExpr("l")} AS origem, ${tagsJson("lead_tags", "lead_id", "l.id")} AS tags
      FROM leads l WHERE l.id = ${id} AND l.deletado_em IS NULL`;
    return rows[0] || null;
}

// GET /api/leads/:id — detalhe + notas + jornada da sessão
router.get("/:id", requireAuth, async (req, res) => {
    const id = intId(req.params.id);
    if (!id) return res.status(400).json({ error: "ID inválido." });
    try {
        const lead = await leadDetail(id);
        if (!lead) return res.status(404).json({ error: "Lead não encontrado." });
        const [notas, journey] = await Promise.all([
            sql`SELECT id, texto, autor, criado_em FROM lead_notes WHERE lead_id = ${id} ORDER BY criado_em DESC`,
            lead.session_id ? sessionJourney(lead.session_id) : null,
        ]);
        let jornada = null;
        if (journey) {
            const firstTs = journey.session.ft_em || journey.session.criado_em;
            const leadTs = new Date(lead.criado_em).getTime();
            const visitasAteConverter = new Set(
                journey.events.filter((e) => e.tipo === "visit_start" && new Date(e.ocorrido_em).getTime() <= leadTs).map((e) => e.visit_id)
            ).size;
            jornada = {
                ...journey,
                tempo_ate_converter_s: Math.max(0, Math.round((leadTs - new Date(firstTs).getTime()) / 1000)),
                visitas_ate_converter: visitasAteConverter,
            };
        }
        res.json({ lead, notas, jornada, status: LEAD_STATUS });
    } catch (err) {
        console.error("Erro ao buscar lead:", err);
        res.status(500).json({ error: "Erro interno." });
    }
});

const patchSchema = z
    .object({
        status: z.enum(LEAD_STATUS_KEYS).optional(),
        nome: z.string().trim().min(2).max(120).optional(),
        email: z.union([z.literal(""), z.string().trim().toLowerCase().email().max(255)]).optional(),
        empresa: z.string().trim().max(160).optional(),
    })
    .refine((o) => Object.keys(o).length > 0, "Nada para atualizar.");

// PATCH /api/leads/:id — status e dados básicos
router.patch("/:id", requireAuth, async (req, res) => {
    const id = intId(req.params.id);
    if (!id) return res.status(400).json({ error: "ID inválido." });
    const b = parse(patchSchema, req.body, res);
    if (!b) return;
    try {
        const updated = await sql`
          UPDATE leads SET
            status = COALESCE(${b.status ?? null}, status),
            status_alterado_em = CASE WHEN ${b.status ?? null}::text IS NOT NULL AND ${b.status ?? null}::text <> status THEN NOW() ELSE status_alterado_em END,
            nome = COALESCE(${b.nome ?? null}, nome),
            email = CASE WHEN ${b.email !== undefined} THEN NULLIF(${b.email ?? ""}, '') ELSE email END,
            empresa = CASE WHEN ${b.empresa !== undefined} THEN NULLIF(${b.empresa ?? ""}, '') ELSE empresa END,
            atualizado_em = NOW()
          WHERE id = ${id} AND deletado_em IS NULL
          RETURNING id`;
        if (updated.length === 0) return res.status(404).json({ error: "Lead não encontrado." });
        if (b.status) {
            await sql`INSERT INTO lead_notes (lead_id, texto, autor) VALUES (${id}, ${`Status alterado para “${LEAD_STATUS.find((s) => s.key === b.status).label}”.`}, ${"sistema:" + req.user.username})`;
        }
        res.json(await leadDetail(id));
    } catch (err) {
        console.error("Erro ao atualizar lead:", err);
        res.status(500).json({ error: "Erro interno." });
    }
});

// DELETE /api/leads/:id — exclusão lógica (recuperável direto no banco)
router.delete("/:id", requireAuth, async (req, res) => {
    const id = intId(req.params.id);
    if (!id) return res.status(400).json({ error: "ID inválido." });
    await sql`UPDATE leads SET deletado_em = NOW() WHERE id = ${id} AND deletado_em IS NULL`;
    res.json({ ok: true });
});

// Notas internas
router.post("/:id/notes", requireAuth, async (req, res) => {
    const id = intId(req.params.id);
    const b = parse(z.object({ texto: z.string().trim().min(1).max(4000) }), req.body, res);
    if (!b) return;
    if (!id) return res.status(400).json({ error: "ID inválido." });
    try {
        const rows = await sql`
          INSERT INTO lead_notes (lead_id, texto, autor)
          SELECT ${id}, ${b.texto}, ${req.user.nome || req.user.username}
          WHERE EXISTS (SELECT 1 FROM leads WHERE id = ${id} AND deletado_em IS NULL)
          RETURNING id, texto, autor, criado_em`;
        if (rows.length === 0) return res.status(404).json({ error: "Lead não encontrado." });
        await sql`UPDATE leads SET atualizado_em = NOW() WHERE id = ${id}`;
        res.status(201).json(rows[0]);
    } catch (err) {
        console.error("Erro ao criar nota:", err);
        res.status(500).json({ error: "Erro interno." });
    }
});

router.delete("/:id/notes/:noteId", requireAuth, async (req, res) => {
    const id = intId(req.params.id);
    const noteId = intId(req.params.noteId);
    if (!id || !noteId) return res.status(400).json({ error: "ID inválido." });
    await sql`DELETE FROM lead_notes WHERE id = ${noteId} AND lead_id = ${id}`;
    res.json({ ok: true });
});

// Tags do lead
const leadTags = (id) => sql`
  SELECT t.id, t.nome, t.cor FROM lead_tags lt JOIN tags t ON t.id = lt.tag_id
  WHERE lt.lead_id = ${id} ORDER BY t.nome`;

router.post("/:id/tags", requireAuth, async (req, res) => {
    const id = intId(req.params.id);
    const tagId = intId(req.body?.tag_id);
    if (!id || !tagId) return res.status(400).json({ error: "Dados inválidos." });
    try {
        await sql`
          INSERT INTO lead_tags (lead_id, tag_id)
          SELECT ${id}, ${tagId}
          WHERE EXISTS (SELECT 1 FROM leads WHERE id = ${id}) AND EXISTS (SELECT 1 FROM tags WHERE id = ${tagId})
          ON CONFLICT DO NOTHING`;
        res.json({ tags: await leadTags(id) });
    } catch (err) {
        console.error("Erro ao vincular tag:", err);
        res.status(500).json({ error: "Erro interno." });
    }
});

router.delete("/:id/tags/:tagId", requireAuth, async (req, res) => {
    const id = intId(req.params.id);
    const tagId = intId(req.params.tagId);
    if (!id || !tagId) return res.status(400).json({ error: "Dados inválidos." });
    await sql`DELETE FROM lead_tags WHERE lead_id = ${id} AND tag_id = ${tagId}`;
    res.json({ tags: await leadTags(id) });
});

module.exports = router;
