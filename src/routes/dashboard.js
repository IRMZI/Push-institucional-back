const express = require("express");
const sql = require("../db");
const { config } = require("../config");
const { requireAuth } = require("../middlewares/auth");
const { parsePeriod } = require("../lib/validation");
const { inPeriod, sourceExpr } = require("../lib/sqlHelpers");
const { LEAD_STATUS } = require("../lib/constants");

const router = express.Router();
router.use(requireAuth);

const tz = config.timezone;

// Investimento proporcional aos dias da campanha que caem no período.
// Sem datas definidas, o investimento é considerado inteiro.
function campaignsInPeriod(p) {
    return sql`
      SELECT c.id, c.nome, c.utm_campaign, c.canal, c.investimento::float AS investimento_total,
        CASE
          WHEN c.inicio IS NOT NULL AND c.fim IS NOT NULL AND c.fim >= c.inicio THEN
            c.investimento::float
            * GREATEST(0, (LEAST(c.fim, ${p.to}::date) - GREATEST(c.inicio, ${p.from}::date) + 1))
            / (c.fim - c.inicio + 1)
          ELSE c.investimento::float
        END AS investimento
      FROM campaigns c
      WHERE c.ativo
        AND (c.inicio IS NULL OR c.inicio <= ${p.to}::date)
        AND (c.fim IS NULL OR c.fim >= ${p.from}::date)`;
}

async function kpis(p) {
    const [[visits], [leads], [conv], camps] = await Promise.all([
        sql`
          SELECT COUNT(*)::int AS sessoes, COUNT(DISTINCT session_id)::int AS visitantes
          FROM session_events WHERE tipo = 'visit_start' AND ${inPeriod("ocorrido_em", p)}`,
        sql`SELECT COUNT(*)::int AS leads FROM leads WHERE deletado_em IS NULL AND ${inPeriod("criado_em", p)}`,
        sql`
          SELECT COUNT(*)::int AS conversoes,
            COUNT(*) FILTER (WHERE tipo = 'whatsapp_click')::int AS whatsapp
          FROM conversoes WHERE ${inPeriod("criado_em", p)}`,
        campaignsInPeriod(p),
    ]);

    let investimento = null;
    let cpl = null;
    if (camps.length > 0) {
        investimento = camps.reduce((s, c) => s + c.investimento, 0);
        const [{ n }] = await sql`
          SELECT COUNT(*)::int AS n FROM leads
          WHERE deletado_em IS NULL AND ${inPeriod("criado_em", p)}
            AND LOWER(utm_campaign) IN ${sql(camps.map((c) => c.utm_campaign.toLowerCase()))}`;
        cpl = n > 0 ? investimento / n : null;
    }

    return {
        visitantes: visits.visitantes,
        sessoes: visits.sessoes,
        leads: leads.leads,
        taxa_conversao: visits.sessoes > 0 ? leads.leads / visits.sessoes : 0,
        whatsapp: conv.whatsapp,
        conversoes: conv.conversoes,
        investimento,
        cpl,
    };
}

// GET /api/dashboard/overview?range=7d | ?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get("/overview", async (req, res) => {
    const p = parsePeriod(req.query, tz);
    const prev = { from: p.prevFrom, to: p.prevTo };
    const visitSource = sql`COALESCE(NULLIF(LOWER(dados->>'utm_source'), ''), NULLIF(dados->>'referrer_host', ''), 'direto')`;

    try {
        const [
            atual,
            anterior,
            serie,
            origensVisitas,
            origensLeads,
            campVisitas,
            campLeads,
            camps,
            funil,
            dispositivos,
            secoes,
            paginas,
            porTipo,
            capi,
            capiUltimo,
            pipeline,
        ] = await Promise.all([
            kpis(p),
            kpis(prev),
            sql`
              SELECT to_char(d, 'YYYY-MM-DD') AS dia,
                COALESCE(s.n, 0)::int AS sessoes, COALESCE(l.n, 0)::int AS leads, COALESCE(c.n, 0)::int AS contatos
              FROM generate_series(${p.from}::date, ${p.to}::date, interval '1 day') d
              LEFT JOIN (
                SELECT (ocorrido_em AT TIME ZONE ${tz})::date AS dia, COUNT(*) AS n
                FROM session_events WHERE tipo = 'visit_start' AND ${inPeriod("ocorrido_em", p)} GROUP BY 1
              ) s ON s.dia = d::date
              LEFT JOIN (
                SELECT (criado_em AT TIME ZONE ${tz})::date AS dia, COUNT(*) AS n
                FROM leads WHERE deletado_em IS NULL AND ${inPeriod("criado_em", p)} GROUP BY 1
              ) l ON l.dia = d::date
              LEFT JOIN (
                SELECT (criado_em AT TIME ZONE ${tz})::date AS dia, COUNT(*) AS n
                FROM conversoes WHERE tipo IN ('whatsapp_click', 'email_click', 'instagram_click') AND ${inPeriod("criado_em", p)} GROUP BY 1
              ) c ON c.dia = d::date
              ORDER BY d`,
            sql`
              SELECT ${visitSource} AS origem, COUNT(*)::int AS sessoes
              FROM session_events WHERE tipo = 'visit_start' AND ${inPeriod("ocorrido_em", p)}
              GROUP BY 1 ORDER BY 2 DESC LIMIT 12`,
            sql`
              SELECT ${sourceExpr("l")} AS origem, COUNT(*)::int AS leads
              FROM leads l WHERE l.deletado_em IS NULL AND ${inPeriod("l.criado_em", p)} GROUP BY 1`,
            sql`
              SELECT dados->>'utm_campaign' AS campanha, COUNT(*)::int AS sessoes
              FROM session_events
              WHERE tipo = 'visit_start' AND dados->>'utm_campaign' IS NOT NULL AND ${inPeriod("ocorrido_em", p)}
              GROUP BY 1 ORDER BY 2 DESC LIMIT 20`,
            sql`
              SELECT utm_campaign AS campanha, COUNT(*)::int AS leads
              FROM leads WHERE deletado_em IS NULL AND utm_campaign IS NOT NULL AND ${inPeriod("criado_em", p)} GROUP BY 1`,
            campaignsInPeriod(p),
            sql`
              SELECT
                COUNT(DISTINCT session_id) FILTER (WHERE tipo = 'visit_start')::int AS visitou,
                COUNT(DISTINCT session_id) FILTER (WHERE tipo = 'section_view' AND nome = 'servicos')::int AS viu_servicos,
                COUNT(DISTINCT session_id) FILTER (WHERE tipo = 'section_view' AND nome = 'cases')::int AS viu_cases,
                COUNT(DISTINCT session_id) FILTER (WHERE tipo = 'form_open')::int AS abriu_formulario,
                COUNT(DISTINCT session_id) FILTER (WHERE tipo = 'form_submit')::int AS enviou
              FROM session_events WHERE ${inPeriod("ocorrido_em", p)}`,
            sql`
              SELECT COALESCE(dados->>'dispositivo', 'desconhecido') AS dispositivo, COUNT(*)::int AS sessoes
              FROM session_events WHERE tipo = 'visit_start' AND ${inPeriod("ocorrido_em", p)}
              GROUP BY 1 ORDER BY 2 DESC`,
            sql`
              SELECT nome AS secao, COUNT(DISTINCT session_id)::int AS visitantes, COUNT(*)::int AS views
              FROM session_events WHERE tipo = 'section_view' AND nome IS NOT NULL AND ${inPeriod("ocorrido_em", p)}
              GROUP BY 1 ORDER BY 2 DESC`,
            sql`
              SELECT pagina, COUNT(*)::int AS views
              FROM session_events WHERE tipo = 'page_view' AND pagina IS NOT NULL AND ${inPeriod("ocorrido_em", p)}
              GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
            sql`
              SELECT tipo, COUNT(*)::int AS total FROM conversoes
              WHERE ${inPeriod("criado_em", p)} GROUP BY 1 ORDER BY 2 DESC`,
            sql`
              SELECT capi_status AS status, COUNT(*)::int AS total FROM conversoes
              WHERE capi_evento IS NOT NULL AND ${inPeriod("criado_em", p)} GROUP BY 1`,
            sql`
              SELECT
                (SELECT MAX(capi_enviado_em) FROM conversoes WHERE capi_status = 'enviado') AS ultimo_envio,
                (SELECT json_build_object('em', capi_enviado_em, 'resposta', capi_resposta, 'id', id)
                   FROM conversoes WHERE capi_status = 'erro' ORDER BY capi_enviado_em DESC NULLS LAST LIMIT 1) AS ultimo_erro`,
            sql`
              SELECT status, COUNT(*)::int AS total FROM leads
              WHERE deletado_em IS NULL AND ${inPeriod("criado_em", p)} GROUP BY 1`,
        ]);

        // Origem: junta sessões (por visita) e leads (last-touch no momento do envio)
        const origemMap = new Map();
        origensVisitas.forEach((o) => origemMap.set(o.origem, { origem: o.origem, sessoes: o.sessoes, leads: 0 }));
        origensLeads.forEach((o) => {
            const cur = origemMap.get(o.origem) || { origem: o.origem, sessoes: 0, leads: 0 };
            cur.leads = o.leads;
            origemMap.set(o.origem, cur);
        });
        const origens = [...origemMap.values()]
            .map((o) => ({ ...o, conversao: o.sessoes > 0 ? o.leads / o.sessoes : null }))
            .sort((a, b) => b.sessoes - a.sessoes || b.leads - a.leads);

        const campMap = new Map();
        const key = (s) => String(s).toLowerCase();
        campVisitas.forEach((c) => campMap.set(key(c.campanha), { campanha: c.campanha, sessoes: c.sessoes, leads: 0 }));
        campLeads.forEach((c) => {
            const cur = campMap.get(key(c.campanha)) || { campanha: c.campanha, sessoes: 0, leads: 0 };
            cur.leads = c.leads;
            campMap.set(key(c.campanha), cur);
        });
        camps.forEach((c) => {
            const cur = campMap.get(key(c.utm_campaign)) || { campanha: c.utm_campaign, sessoes: 0, leads: 0 };
            cur.nome = c.nome;
            cur.investimento = c.investimento;
            campMap.set(key(c.utm_campaign), cur);
        });
        const campanhas = [...campMap.values()]
            .map((c) => ({
                ...c,
                nome: c.nome || null,
                investimento: c.investimento ?? null,
                conversao: c.sessoes > 0 ? c.leads / c.sessoes : null,
                cpl: c.investimento != null && c.leads > 0 ? c.investimento / c.leads : null,
            }))
            .sort((a, b) => b.leads - a.leads || b.sessoes - a.sessoes);

        const f = funil[0];
        const capiResumo = { enviado: 0, erro: 0, pendente: 0, sem_consentimento: 0, desativado: 0 };
        capi.forEach((c) => (capiResumo[c.status] = c.total));

        res.json({
            periodo: p,
            kpis: atual,
            kpis_anterior: anterior,
            serie,
            origens,
            campanhas,
            funil: [
                { etapa: "visitou", label: "Visitou o site", total: f.visitou },
                { etapa: "viu_servicos", label: "Viu serviços", total: f.viu_servicos },
                { etapa: "viu_cases", label: "Viu cases", total: f.viu_cases },
                { etapa: "abriu_formulario", label: "Abriu o formulário", total: f.abriu_formulario },
                { etapa: "enviou", label: "Enviou", total: f.enviou },
            ],
            dispositivos,
            secoes,
            paginas,
            conversoes_por_tipo: porTipo,
            pipeline: LEAD_STATUS.map((s) => ({ ...s, total: pipeline.find((x) => x.status === s.key)?.total || 0 })),
            capi: {
                configurada: Boolean(config.meta.pixelId && config.meta.token),
                modo_teste: Boolean(config.meta.testEventCode),
                ...capiResumo,
                ultimo_envio: capiUltimo[0].ultimo_envio,
                ultimo_erro: capiUltimo[0].ultimo_erro,
            },
        });
    } catch (err) {
        console.error("Erro no overview:", err);
        res.status(500).json({ error: "Erro interno." });
    }
});

module.exports = router;
