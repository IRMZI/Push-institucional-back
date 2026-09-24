const crypto = require("crypto");
const { config } = require("../config");
const sql = require("../db");

const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");

// Normalização exigida pela Meta antes do hash: minúsculas, sem espaços extras e sem acentos.
const norm = (v) =>
    String(v)
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "");

function hashed(v) {
    if (v === null || v === undefined || String(v).trim() === "") return undefined;
    return [sha256(norm(v))];
}

function isEnabled() {
    return Boolean(config.meta.pixelId && config.meta.token);
}

// _fbc pode não existir (cookie bloqueado); com fbclid dá para montá-lo no formato da Meta.
function resolveFbc(fbc, fbclid, createdAtMs = Date.now()) {
    if (fbc) return fbc;
    if (fbclid) return `fb.1.${createdAtMs}.${fbclid}`;
    return undefined;
}

// Monta o payload de um evento server-side. `lead` (opcional) traz os dados pessoais,
// que só saem do servidor em hash SHA-256.
function buildEvent({ eventName, eventId, eventTime, sourceUrl, ip, ua, fbp, fbc, fbclid, sessionId, lead, custom }) {
    const [firstName, ...rest] = lead?.nome ? lead.nome.trim().split(/\s+/) : [];
    const userData = {
        client_ip_address: ip || undefined,
        client_user_agent: ua || undefined,
        fbp: fbp || undefined,
        fbc: resolveFbc(fbc, fbclid),
        em: hashed(lead?.email),
        ph: hashed(lead?.whatsapp),
        fn: hashed(firstName),
        ln: hashed(rest.length ? rest[rest.length - 1] : undefined),
        country: hashed("br"),
        external_id: hashed(sessionId),
    };
    Object.keys(userData).forEach((k) => userData[k] === undefined && delete userData[k]);

    return {
        event_name: eventName,
        event_time: Math.floor((eventTime || Date.now()) / 1000),
        event_id: eventId,
        action_source: "website",
        event_source_url: sourceUrl || undefined,
        user_data: userData,
        custom_data: custom && Object.keys(custom).length ? custom : undefined,
    };
}

async function postEvents(events) {
    const url = `https://graph.facebook.com/${config.meta.apiVersion}/${config.meta.pixelId}/events`;
    const body = { data: events, access_token: config.meta.token };
    if (config.meta.testEventCode) body.test_event_code = config.meta.testEventCode;

    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
    });
    let json;
    try {
        json = await res.json();
    } catch {
        json = { raw: "resposta não-JSON" };
    }
    return { ok: res.ok, status: res.status, body: json };
}

// Envia e registra o resultado na conversão (para depuração no painel).
// Nunca lança: falha da Meta não pode derrubar o registro do lead.
async function sendForConversion(conversaoId, event) {
    if (!isEnabled()) {
        await sql`
          UPDATE conversoes SET capi_status = 'desativado',
            capi_resposta = ${sql.json({ motivo: "META_PIXEL_ID/META_CAPI_TOKEN não configurados" })}
          WHERE id = ${conversaoId}`;
        return { status: "desativado" };
    }
    let result;
    try {
        result = await postEvents([event]);
    } catch (err) {
        result = { ok: false, status: 0, body: { erro: err.name === "TimeoutError" ? "timeout" : err.message } };
    }
    const status = result.ok ? "enviado" : "erro";
    await sql`
      UPDATE conversoes SET
        capi_status = ${status},
        capi_resposta = ${sql.json({ http: result.status, ...result.body, test_event_code: config.meta.testEventCode || undefined })},
        capi_tentativas = capi_tentativas + 1,
        capi_enviado_em = NOW()
      WHERE id = ${conversaoId}`;
    if (!result.ok) console.warn(`[capi] conversão ${conversaoId} falhou:`, JSON.stringify(result.body).slice(0, 300));
    return { status };
}

module.exports = { buildEvent, sendForConversion, isEnabled, sha256, norm, resolveFbc };
