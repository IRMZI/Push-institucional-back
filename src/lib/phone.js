// Normaliza telefone brasileiro para E.164 sem o "+": 55 + DDD + número.
// Retorna null se não parecer um número válido.
function toE164BR(raw) {
    if (typeof raw !== "string" && typeof raw !== "number") return null;
    let d = String(raw).replace(/\D/g, "");
    if (d.startsWith("00")) d = d.slice(2);
    if (d.length === 10 || d.length === 11) d = `55${d}`;
    if (d.startsWith("55") && (d.length === 12 || d.length === 13)) {
        const ddd = Number(d.slice(2, 4));
        if (ddd < 11 || ddd > 99) return null;
        // Celular (13 dígitos) começa com 9 depois do DDD
        if (d.length === 13 && d[4] !== "9") return null;
        return d;
    }
    // Número internacional já com DDI
    if (!d.startsWith("55") && d.length >= 8 && d.length <= 15) return d;
    return null;
}

function formatBR(e164) {
    if (!e164) return "";
    const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(e164);
    return m ? `(${m[1]}) ${m[2]}-${m[3]}` : `+${e164}`;
}

module.exports = { toE164BR, formatBR };
