const sql = require("../db");
const { CAPI_EVENT_BY_TIPO } = require("./constants");
const { buildEvent, sendForConversion } = require("./metaCapi");
const { clientIp, userAgent } = require("./request");

// Tipos que marcam a sessão como "convertida" (cta_click é só intenção)
const CONVERTS_SESSION = new Set(["lead_form", "whatsapp_click", "email_click", "instagram_click"]);

/**
 * Registra uma conversão e dispara a CAPI quando aplicável.
 * Idempotente por event_id: reenvios do mesmo evento (retry do navegador) não duplicam.
 * Retorna { conversao, capi } — `capi` é a promise do envio (não aguardada pelas rotas públicas).
 */
async function registerConversion(req, { tipo, eventId, sessionId, lead, rotulo, pagina, destino, fbp, fbc, fbclid, consentimento }) {
    const capiEvento = CAPI_EVENT_BY_TIPO[tipo] ?? null;
    const ua = userAgent(req);

    // Consentimento LGPD: o evento só vai à Meta se o visitante aceitou cookies de mídia.
    let consent = consentimento ?? null;
    let session = null;
    if (sessionId) {
        const rows = await sql`SELECT id, consentimento, fbclid FROM visitor_sessions WHERE id = ${sessionId}`;
        session = rows[0] || null;
        if (!consent && session) consent = session.consentimento;
    }
    const validSessionId = session ? session.id : null;

    let capiStatus = "nao_aplicavel";
    if (capiEvento) capiStatus = consent === "all" ? "pendente" : "sem_consentimento";

    const inserted = await sql`
      INSERT INTO conversoes (event_id, tipo, session_id, lead_id, rotulo, pagina, destino, fbp, fbc, user_agent, capi_evento, capi_status)
      VALUES (${eventId}, ${tipo}, ${validSessionId}, ${lead?.id ?? null}, ${rotulo ?? null}, ${pagina ?? null},
              ${destino ?? null}, ${fbp ?? null}, ${fbc ?? null}, ${ua}, ${capiEvento}, ${capiStatus})
      ON CONFLICT (event_id) DO NOTHING
      RETURNING *`;

    if (inserted.length === 0) {
        const existing = await sql`SELECT * FROM conversoes WHERE event_id = ${eventId}`;
        return { conversao: existing[0], duplicate: true, capi: Promise.resolve(null) };
    }
    const conversao = inserted[0];

    if (validSessionId && CONVERTS_SESSION.has(tipo)) {
        await sql`
          UPDATE visitor_sessions SET
            convertido = true,
            convertido_em = COALESCE(convertido_em, NOW()),
            lead_id = COALESCE(${lead?.id ?? null}, lead_id),
            ultimo_acesso = NOW()
          WHERE id = ${validSessionId}`;
    }

    let capi = Promise.resolve(null);
    if (capiStatus === "pendente") {
        const event = buildEvent({
            eventName: capiEvento,
            eventId,
            sourceUrl: pagina,
            ip: clientIp(req),
            ua,
            fbp,
            fbc,
            fbclid: fbclid ?? session?.fbclid,
            sessionId: validSessionId,
            lead,
            custom: lead
                ? { content_name: "Formulário de contato", lead_type: (lead.servicos || []).join(",") || undefined }
                : { content_name: rotulo || tipo, content_category: tipo },
        });
        capi = sendForConversion(conversao.id, event).catch((err) => console.error("[capi] erro inesperado:", err));
    }

    return { conversao, duplicate: false, capi };
}

module.exports = { registerConversion };
