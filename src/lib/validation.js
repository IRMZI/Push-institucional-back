const { z } = require("zod");

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isUuid = (v) => typeof v === "string" && UUID_REGEX.test(v);

// String opcional: corta espaços, limita tamanho e transforma vazio em null.
const optStr = (max = 255) =>
    z
        .string()
        .nullish()
        .transform((v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null));

const uuid = z.string().regex(UUID_REGEX, "UUID inválido");

// Lê o corpo como JSON mesmo quando chega como text/plain (navigator.sendBeacon).
function bodyObject(req) {
    if (typeof req.body === "string") {
        try {
            return JSON.parse(req.body);
        } catch {
            return {};
        }
    }
    return req.body && typeof req.body === "object" ? req.body : {};
}

// Valida com zod e responde 400 com a primeira mensagem legível.
function parse(schema, data, res) {
    const result = schema.safeParse(data);
    if (!result.success) {
        const issue = result.error.issues[0];
        const field = issue.path.join(".");
        res.status(400).json({ error: field ? `Campo inválido: ${field}.` : "Dados inválidos.", detalhe: issue.message });
        return null;
    }
    return result.data;
}

// Período do painel. Aceita ?from=YYYY-MM-DD&to=YYYY-MM-DD (dias no fuso de relatórios)
// ou ?range=today|7d|30d|90d. Retorna limites [inicio, fim) em ISO.
function parsePeriod(query, tz) {
    const DATE = /^\d{4}-\d{2}-\d{2}$/;
    const todayLocal = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
    let from = typeof query.from === "string" && DATE.test(query.from) ? query.from : null;
    let to = typeof query.to === "string" && DATE.test(query.to) ? query.to : null;

    if (!from) {
        const days = { today: 1, "7d": 7, "30d": 30, "90d": 90 }[query.range] || 30;
        from = addDays(todayLocal, -(days - 1));
        to = todayLocal;
    }
    if (!to) to = todayLocal;
    if (from > to) [from, to] = [to, from];

    const lengthDays = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
    return {
        from,
        to,
        days: lengthDays,
        // Período anterior de mesmo tamanho — para comparação nos KPIs
        prevFrom: addDays(from, -lengthDays),
        prevTo: addDays(from, -1),
    };
}

function addDays(isoDate, n) {
    const d = new Date(`${isoDate}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

function pagination(query, maxLimit = 200) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), maxLimit);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    return { limit, page, offset: (page - 1) * limit };
}

const intId = (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 && n < 2 ** 31 ? n : null;
};

module.exports = { z, isUuid, optStr, uuid, bodyObject, parse, parsePeriod, addDays, pagination, intId };
