const sql = require("../db");
const { config } = require("../config");

// Condição "coluna dentro do período" com dias no fuso de relatórios. Usa limites
// [início, fim) para aproveitar índices em vez de converter a coluna.
function inPeriod(column, period, tz = config.timezone) {
    const col = sql(column);
    return sql`${col} >= (${period.from}::date::timestamp AT TIME ZONE ${tz})
          AND ${col} < ((${period.to}::date + 1)::timestamp AT TIME ZONE ${tz})`;
}

// Origem legível de uma sessão/lead: utm_source → domínio do referrer → "direto"
const sourceExpr = (prefix = "") => {
    const p = prefix ? `${prefix}.` : "";
    return sql.unsafe(
        `COALESCE(NULLIF(LOWER(${p}utm_source), ''), NULLIF(substring(${p}referrer from '^https?://(?:www\\.)?([^/:?#]+)'), ''), 'direto')`
    );
};

const tagsJson = (joinTable, fkColumn, idRef) =>
    sql.unsafe(`COALESCE((
        SELECT json_agg(json_build_object('id', t.id, 'nome', t.nome, 'cor', t.cor) ORDER BY t.nome)
        FROM ${joinTable} jt JOIN tags t ON t.id = jt.tag_id
        WHERE jt.${fkColumn} = ${idRef}
    ), '[]'::json)`);

module.exports = { inPeriod, sourceExpr, tagsJson };
